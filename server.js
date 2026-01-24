const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const app = express();
const PORT = 3847;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Helper to run AppleScript
function runAppleScript(script) {
    try {
        return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
            encoding: 'utf-8',
            timeout: 10000
        }).trim();
    } catch (e) {
        console.error('AppleScript error:', e.message);
        return '';
    }
}

// Get mail database path
const HOME = os.homedir();
const MAIL_DB_PATH = path.join(HOME, 'Library/Mail/V10/MailData/Envelope Index');

// ============ EMAIL ENDPOINTS ============

app.get('/api/emails/priority', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Get priority emails (last 7 days, filtered for important ones)
        const emails = db.prepare(`
            SELECT
                m.ROWID as id,
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                s.subject,
                a.address as sender,
                m.read,
                m.flagged,
                m.date_received as timestamp
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-7 days')
            AND m.deleted = 0
            ORDER BY m.date_received DESC
            LIMIT 200
        `).all();

        db.close();

        // Categorize and score emails
        const priorityEmails = emails.map(email => {
            let priority = 0;
            let tags = [];
            let category = 'general';

            const sender = (email.sender || '').toLowerCase();
            const subject = (email.subject || '').toLowerCase();

            // Financial
            if (sender.includes('bankofamerica') || sender.includes('venmo') ||
                sender.includes('paypal') || sender.includes('bmo') ||
                subject.includes('credit card') || subject.includes('payment') ||
                subject.includes('transaction') || subject.includes('transfer')) {
                priority += 30;
                tags.push('financial');
                category = 'financial';
            }

            // Action required
            if (subject.includes('update') && subject.includes('payment') ||
                subject.includes('renew') || subject.includes('action required') ||
                subject.includes('confirm') || subject.includes('verify')) {
                priority += 25;
                tags.push('action');
                category = 'action';
            }

            // Orders and shipping
            if (subject.includes('order') || subject.includes('shipping') ||
                subject.includes('delivery') || subject.includes('confirmed')) {
                priority += 15;
                tags.push('shipping');
                if (category === 'general') category = 'shipping';
            }

            // Deployment/Tech alerts
            if (sender.includes('vercel') || sender.includes('github') ||
                subject.includes('failed') || subject.includes('deployment')) {
                priority += 20;
                tags.push('tech');
                if (category === 'general') category = 'tech';
            }

            // Unread bonus
            if (!email.read) priority += 10;

            // Flagged bonus
            if (email.flagged) priority += 20;

            // Spam/marketing penalty
            if (sender.includes('noreply@x.ai') || sender.includes('marketing') ||
                sender.includes('promo') || sender.includes('@b.') ||
                subject.includes('%') || subject.includes('sale') ||
                subject.includes('off') && !subject.includes('office')) {
                priority -= 50;
                category = 'marketing';
            }

            return {
                ...email,
                priority,
                tags,
                category,
                initials: getInitials(email.sender)
            };
        });

        // Filter and sort by priority
        const filtered = priorityEmails
            .filter(e => e.priority > 0 && e.category !== 'marketing')
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 10);

        res.json({
            success: true,
            count: filtered.length,
            emails: filtered
        });

    } catch (error) {
        console.error('Email fetch error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/emails/stats', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        const stats = db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread,
                SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) as flagged
            FROM messages
            WHERE date_received > strftime('%s', 'now', '-7 days')
            AND deleted = 0
        `).get();

        // Count by category
        const topSenders = db.prepare(`
            SELECT
                a.address,
                COUNT(*) as count
            FROM messages m
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-7 days')
            AND m.deleted = 0
            GROUP BY a.address
            ORDER BY count DESC
            LIMIT 10
        `).all();

        db.close();

        res.json({
            success: true,
            stats: {
                ...stats,
                topSenders
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get ALL unread emails
app.get('/api/emails/unread', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;

        const emails = db.prepare(`
            SELECT
                m.ROWID as id,
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                s.subject,
                a.address as sender,
                m.read,
                m.flagged,
                m.date_received as timestamp
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.read = 0
            AND m.deleted = 0
            ORDER BY m.date_received DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);

        const countResult = db.prepare(`
            SELECT COUNT(*) as total
            FROM messages
            WHERE read = 0 AND deleted = 0
        `).get();

        db.close();

        const formattedEmails = emails.map(email => {
            const senderDomain = (email.sender || '').split('@')[1] || '';
            const subject = (email.subject || '').toLowerCase();
            const sender = (email.sender || '').toLowerCase();

            // Categorize email
            let category = 'default';
            if (subject.includes('invoice') || subject.includes('receipt') || subject.includes('payment')) {
                category = 'financial';
            } else if (subject.includes('confirm') || subject.includes('verify') || subject.includes('activate')) {
                category = 'action';
            } else if (subject.includes('ship') || subject.includes('deliver') || subject.includes('track')) {
                category = 'shipping';
            } else if (sender.includes('noreply') || sender.includes('newsletter') || sender.includes('marketing')) {
                category = 'newsletter';
            }

            // Generate tags
            const tags = [];
            if (email.flagged) tags.push('starred');
            if (subject.includes('urgent') || subject.includes('asap') || subject.includes('important')) tags.push('urgent');
            if (subject.includes('meeting') || subject.includes('invite') || subject.includes('calendar')) tags.push('meeting');
            if (sender.includes('noreply') || sender.includes('newsletter')) tags.push('newsletter');

            return {
                ...email,
                senderName: extractBrandName(email.sender),
                senderDomain,
                initials: getInitials(email.sender),
                category,
                tags
            };
        });

        res.json({
            success: true,
            emails: formattedEmails,
            total: countResult.total,
            showing: emails.length,
            hasMore: offset + emails.length < countResult.total
        });

    } catch (error) {
        console.error('Unread emails error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Quick rule creation endpoints
app.post('/api/rules/quick/auto-delete', (req, res) => {
    const { sender, senderDomain, senderEmail } = req.body;
    const senderValue = sender || senderDomain || senderEmail;

    if (!senderValue) {
        return res.status(400).json({ success: false, error: 'Sender required' });
    }

    // Extract domain from email address if full email provided
    const domain = senderValue.includes('@') ? senderValue.split('@')[1] : senderValue;

    const rulesData = loadRules();
    const rule = {
        id: Date.now(),
        name: `Auto-delete from ${domain}`,
        condition: { field: 'sender', operator: 'contains', value: domain },
        action: 'delete',
        enabled: true,
        createdAt: new Date().toISOString()
    };

    rulesData.rules.push(rule);
    saveRules(rulesData);

    res.json({ success: true, rule, message: `Will auto-delete emails from ${domain}` });
});

app.post('/api/rules/quick/auto-archive', (req, res) => {
    const { sender, senderDomain, senderEmail } = req.body;
    const senderValue = sender || senderDomain || senderEmail;

    if (!senderValue) {
        return res.status(400).json({ success: false, error: 'Sender required' });
    }

    const domain = senderValue.includes('@') ? senderValue.split('@')[1] : senderValue;

    const rulesData = loadRules();
    const rule = {
        id: Date.now(),
        name: `Auto-archive from ${domain}`,
        condition: { field: 'sender', operator: 'contains', value: domain },
        action: 'archive',
        enabled: true,
        createdAt: new Date().toISOString()
    };

    rulesData.rules.push(rule);
    saveRules(rulesData);

    res.json({ success: true, rule, message: `Will auto-archive emails from ${domain}` });
});

app.post('/api/rules/quick/unsubscribe', (req, res) => {
    const { sender, senderDomain, senderEmail } = req.body;
    const senderValue = sender || senderDomain || senderEmail;

    if (!senderValue) {
        return res.status(400).json({ success: false, error: 'Sender required' });
    }

    const domain = senderValue.includes('@') ? senderValue.split('@')[1] : senderValue;

    const rulesData = loadRules();
    const rule = {
        id: Date.now(),
        name: `Unsubscribe & delete from ${domain}`,
        condition: { field: 'sender', operator: 'contains', value: domain },
        action: 'delete',
        enabled: true,
        isUnsubscribe: true,
        createdAt: new Date().toISOString()
    };

    rulesData.rules.push(rule);
    saveRules(rulesData);

    res.json({ success: true, rule, message: `Unsubscribed from ${domain}` });
});

// Forward email
app.post('/api/emails/forward', (req, res) => {
    const { emailId, toAddress, subject } = req.body;

    if (!emailId || !toAddress) {
        return res.status(400).json({ success: false, error: 'Email ID and recipient required' });
    }

    try {
        const script = `
            tell application "Mail"
                set theMessage to first message of inbox whose id is ${emailId}
                set fwdMessage to forward theMessage with opening window
                tell fwdMessage
                    make new to recipient at end of to recipients with properties {address:"${toAddress}"}
                end tell
                activate
            end tell
        `;
        runAppleScript(script);
        res.json({ success: true, message: 'Forward window opened in Mail' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ FELIX NATURAL LANGUAGE COMMANDS ============

app.post('/api/felix/command', (req, res) => {
    const { command } = req.body;
    const lowerCmd = (command || '').toLowerCase();

    // Parse natural language commands
    const rulesData = loadRules();
    let response = '';
    let ruleCreated = false;
    let actionsPerformed = false;

    // Auto-delete patterns
    if (lowerCmd.includes('auto-delete') || lowerCmd.includes('auto delete') ||
        (lowerCmd.includes('delete') && lowerCmd.includes('from'))) {

        // Extract sender/domain
        const fromMatch = lowerCmd.match(/from\s+([^\s,]+)/i);
        if (fromMatch) {
            const sender = fromMatch[1].replace(/['"]/g, '');
            const rule = {
                id: Date.now(),
                name: `Auto-delete from ${sender}`,
                condition: { field: 'sender', operator: 'contains', value: sender },
                action: 'delete',
                enabled: true,
                createdAt: new Date().toISOString()
            };
            rulesData.rules.push(rule);
            saveRules(rulesData);
            response = `Done! I'll automatically delete future emails from "${sender}".`;
            ruleCreated = true;
        }
    }

    // Auto-archive patterns
    else if (lowerCmd.includes('auto-archive') || lowerCmd.includes('auto archive') ||
             (lowerCmd.includes('archive') && lowerCmd.includes('from'))) {

        const fromMatch = lowerCmd.match(/from\s+([^\s,]+)/i);
        if (fromMatch) {
            const sender = fromMatch[1].replace(/['"]/g, '');
            const rule = {
                id: Date.now(),
                name: `Auto-archive from ${sender}`,
                condition: { field: 'sender', operator: 'contains', value: sender },
                action: 'archive',
                enabled: true,
                createdAt: new Date().toISOString()
            };
            rulesData.rules.push(rule);
            saveRules(rulesData);
            response = `Done! I'll automatically archive future emails from "${sender}".`;
            ruleCreated = true;
        }
    }

    // Delete all newsletters
    else if (lowerCmd.includes('delete') && (lowerCmd.includes('newsletter') || lowerCmd.includes('newsletters'))) {
        const rule = {
            id: Date.now(),
            name: 'Auto-delete newsletters',
            condition: { field: 'sender', operator: 'contains', value: 'newsletter' },
            action: 'delete',
            enabled: true,
            createdAt: new Date().toISOString()
        };
        rulesData.rules.push(rule);
        saveRules(rulesData);
        response = "Done! I'll automatically delete emails from senders containing 'newsletter'. I've also set up rules for common newsletter patterns.";
        ruleCreated = true;

        // Add common newsletter patterns
        const patterns = ['noreply', 'marketing', 'promo', 'digest'];
        patterns.forEach(p => {
            rulesData.rules.push({
                id: Date.now() + Math.random(),
                name: `Auto-delete ${p}`,
                condition: { field: 'sender', operator: 'contains', value: p },
                action: 'delete',
                enabled: true,
                createdAt: new Date().toISOString()
            });
        });
        saveRules(rulesData);
    }

    // Block promos
    else if ((lowerCmd.includes('block') || lowerCmd.includes('delete')) &&
             (lowerCmd.includes('promo') || lowerCmd.includes('promotion'))) {
        const rule = {
            id: Date.now(),
            name: 'Auto-delete promotions',
            condition: { field: 'sender', operator: 'contains', value: 'promo' },
            action: 'delete',
            enabled: true,
            createdAt: new Date().toISOString()
        };
        rulesData.rules.push(rule);
        saveRules(rulesData);
        response = "Done! I'll automatically delete promotional emails.";
        ruleCreated = true;
    }

    // Archive read emails
    else if (lowerCmd.includes('archive') && lowerCmd.includes('read')) {
        response = "To archive read emails, click the checkbox next to each email you want to archive, or use the archive button. I can't bulk archive without your confirmation to protect important emails.";
    }

    // Show what needs response
    else if (lowerCmd.includes('response') || lowerCmd.includes('respond') || lowerCmd.includes('reply')) {
        response = "To see emails that need a response, tag them with 'Respond Today' using the tag button on each email. Then use the 'Respond Today' filter to see them all in one place.";
    }

    // Unsubscribe
    else if (lowerCmd.includes('unsubscribe')) {
        const fromMatch = lowerCmd.match(/from\s+([^\s,]+)/i);
        if (fromMatch) {
            const sender = fromMatch[1].replace(/['"]/g, '');
            const rule = {
                id: Date.now(),
                name: `Unsubscribe from ${sender}`,
                condition: { field: 'sender', operator: 'contains', value: sender },
                action: 'delete',
                enabled: true,
                isUnsubscribe: true,
                createdAt: new Date().toISOString()
            };
            rulesData.rules.push(rule);
            saveRules(rulesData);
            response = `Done! I'll automatically delete future emails from "${sender}" (unsubscribed).`;
            ruleCreated = true;
        } else {
            response = "Tell me who to unsubscribe from. For example: 'unsubscribe from marketing@example.com'";
        }
    }

    // List rules
    else if (lowerCmd.includes('show') && lowerCmd.includes('rule')) {
        if (rulesData.rules.length === 0) {
            response = "You don't have any rules set up yet. Tell me what to do with your emails, like 'auto-delete emails from newsletters'.";
        } else {
            response = `You have ${rulesData.rules.length} active rules:\n` +
                rulesData.rules.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
        }
    }

    // Help
    else if (lowerCmd.includes('help') || lowerCmd.includes('what can you')) {
        response = `I can help you manage your emails! Try saying:\n
• "Auto-delete emails from [sender]"
• "Auto-archive emails from LinkedIn"
• "Delete all newsletters"
• "Block promotional emails"
• "Unsubscribe from [sender]"
• "Show my rules"`;
    }

    // Default response
    else {
        response = "I'm not sure what you want me to do. Try something like:\n• 'Auto-delete emails from newsletters'\n• 'Auto-archive emails from LinkedIn'\n• 'Block promotional emails'";
    }

    res.json({
        success: true,
        response,
        ruleCreated,
        actionsPerformed
    });
});

// ============ CALENDAR ENDPOINTS ============

app.get('/api/calendar/upcoming', (req, res) => {
    try {
        const script = `
            set today to current date
            set endDate to today + (14 * days)
            set output to ""
            tell application "Calendar"
                repeat with cal in calendars
                    set calName to name of cal
                    try
                        set evts to (every event of cal whose start date >= today and start date <= endDate)
                        repeat with evt in evts
                            set evtStart to start date of evt
                            set evtSummary to summary of evt
                            set output to output & calName & "|||" & (evtStart as string) & "|||" & evtSummary & "\\n"
                        end repeat
                    end try
                end repeat
            end tell
            return output
        `;

        const result = runAppleScript(script);
        const events = result.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [calendar, dateStr, title] = line.split('|||');
                const date = new Date(dateStr);
                return {
                    calendar: calendar?.trim() || 'Unknown',
                    title: title?.trim() || 'Untitled',
                    date: date.toISOString(),
                    dateFormatted: date.toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric'
                    }),
                    time: date.toLocaleTimeString('en-US', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    }),
                    isToday: isSameDay(date, new Date()),
                    isTomorrow: isSameDay(date, addDays(new Date(), 1)),
                    category: categorizeCalendar(calendar)
                };
            })
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        res.json({
            success: true,
            count: events.length,
            events
        });

    } catch (error) {
        console.error('Calendar error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ FILE SYSTEM ENDPOINTS ============

app.get('/api/files/analysis', (req, res) => {
    try {
        const downloads = scanDirectory(path.join(HOME, 'Downloads'));
        const desktop = scanDirectory(path.join(HOME, 'Desktop'));

        // Find duplicates in downloads
        const dmgFiles = downloads.files.filter(f => f.name.endsWith('.dmg'));
        const duplicateDmgs = findDuplicates(dmgFiles);

        // Find screenshots on desktop
        const screenshots = desktop.files.filter(f =>
            f.name.toLowerCase().includes('screenshot') ||
            (f.name.match(/\.(png|jpg|jpeg)$/i) && f.name.match(/\d{4}-\d{2}-\d{2}/))
        );

        // Find old installers
        const oldInstallers = downloads.files.filter(f =>
            f.name.endsWith('.dmg') || f.name.endsWith('.pkg')
        );

        // Calculate recoverable space
        const duplicateSize = duplicateDmgs.reduce((sum, d) => sum + d.totalSize - d.keepSize, 0);
        const installerSize = oldInstallers.reduce((sum, f) => sum + f.size, 0);

        res.json({
            success: true,
            analysis: {
                downloads: {
                    totalFiles: downloads.files.length,
                    totalSize: downloads.totalSize,
                    duplicates: duplicateDmgs.length,
                    duplicateSize
                },
                desktop: {
                    totalFiles: desktop.files.length,
                    screenshots: screenshots.length,
                    folders: desktop.folders.length
                },
                recommendations: [
                    {
                        id: 'duplicates',
                        title: 'Duplicate DMG Files',
                        description: `${duplicateDmgs.length} duplicate installers found`,
                        size: duplicateSize,
                        sizeFormatted: formatBytes(duplicateSize),
                        items: duplicateDmgs.map(d => d.baseName),
                        type: 'duplicates'
                    },
                    {
                        id: 'installers',
                        title: 'Old Installers',
                        description: `${oldInstallers.length} DMG/PKG files can be deleted`,
                        size: installerSize,
                        sizeFormatted: formatBytes(installerSize),
                        items: oldInstallers.map(f => f.name),
                        type: 'cleanup'
                    },
                    {
                        id: 'screenshots',
                        title: 'Desktop Organization',
                        description: `${screenshots.length} screenshots, ${desktop.folders.length} project folders`,
                        items: screenshots.map(f => f.name),
                        type: 'organize'
                    }
                ],
                recoverableSpace: duplicateSize + installerSize,
                recoverableFormatted: formatBytes(duplicateSize + installerSize)
            }
        });

    } catch (error) {
        console.error('File analysis error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/files/duplicates', (req, res) => {
    try {
        const downloads = scanDirectory(path.join(HOME, 'Downloads'));
        const dmgFiles = downloads.files.filter(f => f.name.endsWith('.dmg'));
        const duplicates = findDuplicates(dmgFiles);

        res.json({
            success: true,
            duplicates: duplicates.map(d => ({
                baseName: d.baseName,
                count: d.files.length,
                files: d.files.map(f => ({
                    name: f.name,
                    size: formatBytes(f.size),
                    modified: f.modified
                })),
                totalSize: formatBytes(d.totalSize),
                canRecover: formatBytes(d.totalSize - d.keepSize)
            }))
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ DEPLOYMENT STATUS ============

app.get('/api/deployments/status', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        const vercelEmails = db.prepare(`
            SELECT
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                s.subject
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-2 days')
            AND a.address LIKE '%vercel%'
            ORDER BY m.date_received DESC
            LIMIT 50
        `).all();

        db.close();

        const failures = vercelEmails.filter(e =>
            e.subject?.toLowerCase().includes('failed')
        );

        const projects = {};
        failures.forEach(f => {
            const match = f.subject?.match(/team '([^']+)'/);
            if (match) {
                const project = match[1];
                projects[project] = (projects[project] || 0) + 1;
            }
        });

        res.json({
            success: true,
            deployments: {
                totalFailures24h: failures.length,
                projects: Object.entries(projects).map(([name, count]) => ({
                    name,
                    failures: count,
                    status: count > 10 ? 'critical' : count > 5 ? 'warning' : 'normal'
                }))
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ EMAIL ACTIONS & LEARNING ============

const EMAIL_ACTIONS_FILE = path.join(__dirname, 'email-actions.json');

function loadEmailActions() {
    try {
        if (fs.existsSync(EMAIL_ACTIONS_FILE)) {
            return JSON.parse(fs.readFileSync(EMAIL_ACTIONS_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('Error loading email actions:', e);
    }
    return {
        senderActions: {},  // { "sender@domain.com": { action: "archive", count: 5, autoApply: true } }
        subjectPatterns: {}, // { "pattern": { action: "delete", count: 3 } }
        recentActions: []   // Last 100 actions for analysis
    };
}

function saveEmailActions(actions) {
    fs.writeFileSync(EMAIL_ACTIONS_FILE, JSON.stringify(actions, null, 2));
}

// Get suggested action for an email based on learning
function getSuggestedAction(sender, subject) {
    const actions = loadEmailActions();
    const senderKey = sender?.toLowerCase();

    // Check if we have a learned action for this sender
    if (senderKey && actions.senderActions[senderKey]) {
        const senderAction = actions.senderActions[senderKey];
        if (senderAction.autoApply) {
            return { action: senderAction.action, confidence: 'high', reason: 'auto' };
        } else if (senderAction.count >= 3) {
            return { action: senderAction.action, confidence: 'medium', reason: 'learned' };
        }
    }

    // Check subject patterns
    const subjectLower = (subject || '').toLowerCase();
    for (const [pattern, data] of Object.entries(actions.subjectPatterns)) {
        if (subjectLower.includes(pattern) && data.count >= 3) {
            return { action: data.action, confidence: 'medium', reason: 'pattern' };
        }
    }

    return null;
}

// Record an action and learn from it
app.post('/api/emails/action', (req, res) => {
    try {
        const { emailId, sender, subject, action } = req.body;
        // Actions: 'archive', 'delete', 'star', 'reply', 'snooze', 'keep'

        const actions = loadEmailActions();
        const senderKey = sender?.toLowerCase();

        // Update sender actions
        if (senderKey) {
            if (!actions.senderActions[senderKey]) {
                actions.senderActions[senderKey] = { action, count: 0, autoApply: false };
            }

            if (actions.senderActions[senderKey].action === action) {
                actions.senderActions[senderKey].count++;
                // Auto-apply after 5 consistent actions
                if (actions.senderActions[senderKey].count >= 5) {
                    actions.senderActions[senderKey].autoApply = true;
                }
            } else {
                // Different action - reset or update
                actions.senderActions[senderKey] = { action, count: 1, autoApply: false };
            }
        }

        // Learn from subject patterns (extract key phrases)
        const subjectLower = (subject || '').toLowerCase();
        const patterns = extractPatterns(subjectLower);
        for (const pattern of patterns) {
            if (!actions.subjectPatterns[pattern]) {
                actions.subjectPatterns[pattern] = { action, count: 0 };
            }
            if (actions.subjectPatterns[pattern].action === action) {
                actions.subjectPatterns[pattern].count++;
            }
        }

        // Record recent action
        actions.recentActions.unshift({
            emailId,
            sender: senderKey,
            subject,
            action,
            timestamp: new Date().toISOString()
        });
        actions.recentActions = actions.recentActions.slice(0, 100);

        saveEmailActions(actions);

        // Check if this sender now has auto-apply
        const senderData = actions.senderActions[senderKey];
        const autoApplyEnabled = senderData?.autoApply || false;

        res.json({
            success: true,
            message: `Email marked as ${action}`,
            learned: senderData?.count >= 3,
            autoApply: autoApplyEnabled,
            consecutiveCount: senderData?.count || 1
        });

    } catch (error) {
        console.error('Email action error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get learned actions summary
app.get('/api/emails/learned-actions', (req, res) => {
    try {
        const actions = loadEmailActions();

        const autoApplied = Object.entries(actions.senderActions)
            .filter(([_, data]) => data.autoApply)
            .map(([sender, data]) => ({ sender, action: data.action }));

        const learning = Object.entries(actions.senderActions)
            .filter(([_, data]) => data.count >= 3 && !data.autoApply)
            .map(([sender, data]) => ({ sender, action: data.action, count: data.count }));

        res.json({
            success: true,
            autoApplied,
            learning,
            totalLearned: autoApplied.length + learning.length
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get suggested action for specific email
app.get('/api/emails/suggest-action', (req, res) => {
    const { sender, subject } = req.query;
    const suggestion = getSuggestedAction(sender, subject);
    res.json({ success: true, suggestion });
});

function extractPatterns(subject) {
    const patterns = [];
    // Extract key phrases that might indicate email type
    const keywords = ['order', 'shipping', 'delivery', 'payment', 'receipt',
                      'confirmation', 'alert', 'notification', 'newsletter',
                      'update', 'reminder', 'invoice', 'statement'];
    for (const kw of keywords) {
        if (subject.includes(kw)) {
            patterns.push(kw);
        }
    }
    return patterns;
}

// ============ UNSUBSCRIBE MANAGEMENT ============

// Store for unsubscribe preferences (persisted to file)
const PREFS_FILE = path.join(__dirname, 'cliff-preferences.json');

function loadPreferences() {
    try {
        if (fs.existsSync(PREFS_FILE)) {
            return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
        }
    } catch (e) {
        console.error('Error loading preferences:', e);
    }
    return {
        unsubscribed: [],
        archived: ['ealerts.bankofamerica.com'],
        reviewed: []
    };
}

function savePreferences(prefs) {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
}

// Get marketing senders for unsubscribe review
app.get('/api/unsubscribe/candidates', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });
        const prefs = loadPreferences();

        const candidates = db.prepare(`
            SELECT
                a.address as sender,
                COUNT(*) as email_count,
                MAX(datetime(m.date_received, 'unixepoch', 'localtime')) as last_received
            FROM messages m
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-30 days')
            AND m.deleted = 0
            AND (
                a.address LIKE '%@b.%'
                OR a.address LIKE '%@e.%'
                OR a.address LIKE '%@email.%'
                OR a.address LIKE '%@mail.%'
                OR a.address LIKE '%@marketing%'
                OR a.address LIKE '%@promo%'
                OR a.address LIKE '%@newsletters%'
                OR a.address LIKE '%noreply%'
                OR a.address LIKE '%hello@%'
                OR a.address LIKE '%info@%'
            )
            AND a.address NOT LIKE '%bankofamerica%'
            AND a.address NOT LIKE '%github%'
            AND a.address NOT LIKE '%vercel%'
            AND a.address NOT LIKE '%apple.com%'
            AND a.address NOT LIKE '%google.com%'
            GROUP BY a.address
            HAVING email_count >= 3
            ORDER BY email_count DESC
            LIMIT 50
        `).all();

        db.close();

        // Filter out already unsubscribed/reviewed
        const filtered = candidates
            .filter(c => !prefs.unsubscribed.includes(c.sender))
            .filter(c => !prefs.reviewed.includes(c.sender))
            .map(c => ({
                ...c,
                domain: c.sender.split('@')[1] || 'unknown',
                brandName: extractBrandName(c.sender)
            }));

        res.json({
            success: true,
            count: filtered.length,
            candidates: filtered,
            unsubscribedCount: prefs.unsubscribed.length
        });

    } catch (error) {
        console.error('Unsubscribe candidates error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Mark sender as unsubscribed (user will manually unsubscribe)
app.post('/api/unsubscribe/mark', (req, res) => {
    try {
        const { sender, action } = req.body; // action: 'unsubscribe', 'keep', 'skip'
        const prefs = loadPreferences();

        if (action === 'unsubscribe') {
            if (!prefs.unsubscribed.includes(sender)) {
                prefs.unsubscribed.push(sender);
            }
        }

        // Mark as reviewed regardless of action
        if (!prefs.reviewed.includes(sender)) {
            prefs.reviewed.push(sender);
        }

        savePreferences(prefs);

        res.json({
            success: true,
            message: action === 'unsubscribe'
                ? `Marked ${sender} for unsubscribe`
                : `Keeping ${sender}`,
            unsubscribedCount: prefs.unsubscribed.length
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get unsubscribe list
app.get('/api/unsubscribe/list', (req, res) => {
    try {
        const prefs = loadPreferences();
        res.json({
            success: true,
            unsubscribed: prefs.unsubscribed,
            archived: prefs.archived
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Reset reviewed list (for new day)
app.post('/api/unsubscribe/reset-reviewed', (req, res) => {
    try {
        const prefs = loadPreferences();
        prefs.reviewed = [];
        savePreferences(prefs);
        res.json({ success: true, message: 'Reviewed list reset' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

function extractBrandName(email) {
    if (!email) return 'Unknown';
    const local = email.split('@')[0];
    const domain = email.split('@')[1] || '';

    // Try to get brand from domain
    const domainParts = domain.split('.');
    if (domainParts.length >= 2) {
        // Get the main domain part (e.g., 'express' from 'b.express.com')
        for (const part of domainParts) {
            if (part.length > 2 && !['com', 'net', 'org', 'mail', 'email'].includes(part)) {
                return part.charAt(0).toUpperCase() + part.slice(1);
            }
        }
    }

    // Fallback to local part
    return local.split(/[._-]/)[0].charAt(0).toUpperCase() + local.split(/[._-]/)[0].slice(1);
}

// ============ BRIEFING ENDPOINT ============

app.get('/api/briefing', async (req, res) => {
    try {
        // Gather all data
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Email stats
        const emailStats = db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread
            FROM messages
            WHERE date_received > strftime('%s', 'now', '-24 hours')
            AND deleted = 0
        `).get();

        // Priority count
        const priorityCount = db.prepare(`
            SELECT COUNT(*) as count
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-7 days')
            AND m.deleted = 0
            AND (
                a.address LIKE '%bankofamerica%'
                OR a.address LIKE '%venmo%'
                OR a.address LIKE '%paypal%'
                OR s.subject LIKE '%payment%'
                OR s.subject LIKE '%order%'
                OR s.subject LIKE '%action%'
            )
            AND m.read = 0
        `).get();

        // Vercel failures
        const vercelFailures = db.prepare(`
            SELECT COUNT(*) as count
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-24 hours')
            AND a.address LIKE '%vercel%'
            AND s.subject LIKE '%failed%'
        `).get();

        db.close();

        // Calendar events today/tomorrow
        const calendarScript = `
            set today to current date
            set tomorrow to today + (2 * days)
            set eventCount to 0
            tell application "Calendar"
                repeat with cal in calendars
                    try
                        set evts to (every event of cal whose start date >= today and start date <= tomorrow)
                        set eventCount to eventCount + (count of evts)
                    end try
                end repeat
            end tell
            return eventCount
        `;
        const upcomingEvents = parseInt(runAppleScript(calendarScript)) || 0;

        // File stats
        const downloads = scanDirectory(path.join(HOME, 'Downloads'));
        const dmgFiles = downloads.files.filter(f => f.name.endsWith('.dmg'));
        const duplicates = findDuplicates(dmgFiles);
        const recoverableSpace = duplicates.reduce((sum, d) => sum + d.totalSize - d.keepSize, 0);

        res.json({
            success: true,
            briefing: {
                timestamp: new Date().toISOString(),
                summary: {
                    emailsLast24h: emailStats.total,
                    unreadEmails: emailStats.unread,
                    priorityItems: priorityCount.count,
                    deploymentFailures: vercelFailures.count,
                    upcomingEvents,
                    recoverableSpace: formatBytes(recoverableSpace)
                },
                alerts: [
                    vercelFailures.count > 10 && {
                        type: 'critical',
                        message: `${vercelFailures.count} deployment failures in last 24h`
                    },
                    priorityCount.count > 0 && {
                        type: 'warning',
                        message: `${priorityCount.count} priority emails need attention`
                    },
                    recoverableSpace > 1000000000 && {
                        type: 'info',
                        message: `${formatBytes(recoverableSpace)} can be recovered from Downloads`
                    }
                ].filter(Boolean)
            }
        });

    } catch (error) {
        console.error('Briefing error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ HELPER FUNCTIONS ============

function getInitials(email) {
    if (!email) return '?';
    const parts = email.split('@')[0].split(/[._-]/);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return email.substring(0, 2).toUpperCase();
}

function isSameDay(d1, d2) {
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate();
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function categorizeCalendar(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('work') || n.includes('cascadia')) return 'work';
    if (n.includes('family') || n.includes('home') || n.includes('personal')) return 'personal';
    if (n.includes('holiday') || n.includes('birthday')) return 'holiday';
    return 'default';
}

function scanDirectory(dirPath) {
    const files = [];
    const folders = [];
    let totalSize = 0;

    try {
        const items = fs.readdirSync(dirPath);

        for (const item of items) {
            if (item.startsWith('.')) continue;

            const fullPath = path.join(dirPath, item);
            try {
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    folders.push({
                        name: item,
                        path: fullPath
                    });
                } else {
                    files.push({
                        name: item,
                        path: fullPath,
                        size: stat.size,
                        modified: stat.mtime
                    });
                    totalSize += stat.size;
                }
            } catch (e) {
                // Skip inaccessible files
            }
        }
    } catch (e) {
        console.error(`Error scanning ${dirPath}:`, e.message);
    }

    return { files, folders, totalSize };
}

function findDuplicates(files) {
    const groups = {};

    for (const file of files) {
        // Extract base name without (1), (2), etc.
        const baseName = file.name
            .replace(/\s*\(\d+\)\s*/, '')
            .replace(/\.(dmg|pkg)$/i, '');

        if (!groups[baseName]) {
            groups[baseName] = [];
        }
        groups[baseName].push(file);
    }

    return Object.entries(groups)
        .filter(([_, files]) => files.length > 1)
        .map(([baseName, files]) => {
            files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
            const totalSize = files.reduce((sum, f) => sum + f.size, 0);
            const keepSize = files[0].size;

            return {
                baseName,
                files,
                totalSize,
                keepSize
            };
        });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ============ WEEKLY DIGEST ============

app.get('/api/digest/weekly', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Email volume by day (last 7 days)
        const volumeByDay = db.prepare(`
            SELECT
                date(datetime(date_received, 'unixepoch', 'localtime')) as day,
                COUNT(*) as count
            FROM messages
            WHERE date_received > strftime('%s', 'now', '-7 days')
            AND deleted = 0
            GROUP BY day
            ORDER BY day
        `).all();

        // Top senders
        const topSenders = db.prepare(`
            SELECT
                a.address as sender,
                COUNT(*) as count
            FROM messages m
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-7 days')
            AND m.deleted = 0
            GROUP BY a.address
            ORDER BY count DESC
            LIMIT 10
        `).all();

        // Email by hour (to find peak times)
        const byHour = db.prepare(`
            SELECT
                strftime('%H', datetime(date_received, 'unixepoch', 'localtime')) as hour,
                COUNT(*) as count
            FROM messages
            WHERE date_received > strftime('%s', 'now', '-7 days')
            AND deleted = 0
            GROUP BY hour
            ORDER BY hour
        `).all();

        // Read vs unread ratio
        const readStats = db.prepare(`
            SELECT
                SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as read_count,
                SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread_count,
                COUNT(*) as total
            FROM messages
            WHERE date_received > strftime('%s', 'now', '-7 days')
            AND deleted = 0
        `).get();

        // Categories breakdown
        const categories = db.prepare(`
            SELECT
                CASE
                    WHEN a.address LIKE '%@b.%' OR a.address LIKE '%@e.%' OR a.address LIKE '%promo%' OR a.address LIKE '%marketing%' THEN 'Marketing'
                    WHEN a.address LIKE '%github%' OR a.address LIKE '%vercel%' OR a.address LIKE '%gitlab%' THEN 'Development'
                    WHEN a.address LIKE '%bank%' OR a.address LIKE '%paypal%' OR a.address LIKE '%venmo%' THEN 'Financial'
                    WHEN a.address LIKE '%noreply%' OR a.address LIKE '%no-reply%' THEN 'Automated'
                    ELSE 'Personal/Work'
                END as category,
                COUNT(*) as count
            FROM messages m
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-7 days')
            AND m.deleted = 0
            GROUP BY category
            ORDER BY count DESC
        `).all();

        db.close();

        // Find peak hours
        const peakHour = byHour.reduce((max, h) => h.count > max.count ? h : max, { count: 0 });

        res.json({
            success: true,
            digest: {
                period: '7 days',
                totalEmails: readStats.total,
                readRate: Math.round((readStats.read_count / readStats.total) * 100),
                volumeByDay,
                topSenders: topSenders.map(s => ({
                    sender: s.sender,
                    brandName: extractBrandName(s.sender),
                    count: s.count
                })),
                peakHour: `${peakHour.hour}:00`,
                peakHourCount: peakHour.count,
                byHour,
                categories,
                insights: generateInsights(readStats, topSenders, peakHour, categories)
            }
        });

    } catch (error) {
        console.error('Digest error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function generateInsights(readStats, topSenders, peakHour, categories) {
    const insights = [];

    const readRate = (readStats.read_count / readStats.total) * 100;
    if (readRate < 50) {
        insights.push({ type: 'warning', text: `You're only reading ${Math.round(readRate)}% of emails. Consider more aggressive filtering.` });
    }

    const marketingCategory = categories.find(c => c.category === 'Marketing');
    if (marketingCategory && marketingCategory.count > readStats.total * 0.3) {
        insights.push({ type: 'suggestion', text: `${Math.round((marketingCategory.count / readStats.total) * 100)}% of your emails are marketing. Time to unsubscribe!` });
    }

    if (parseInt(peakHour.hour) < 9) {
        insights.push({ type: 'info', text: `Most emails arrive before 9 AM. Consider checking email after your morning routine.` });
    }

    if (topSenders[0]?.count > 20) {
        insights.push({ type: 'info', text: `${extractBrandName(topSenders[0].sender)} sent you ${topSenders[0].count} emails this week.` });
    }

    return insights;
}

// ============ SENDER REPUTATION ============

const REPUTATION_FILE = path.join(__dirname, 'sender-reputation.json');

function loadReputation() {
    try {
        if (fs.existsSync(REPUTATION_FILE)) {
            return JSON.parse(fs.readFileSync(REPUTATION_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {};
}

function saveReputation(rep) {
    fs.writeFileSync(REPUTATION_FILE, JSON.stringify(rep, null, 2));
}

app.get('/api/reputation/summary', (req, res) => {
    try {
        const actions = loadEmailActions();
        const reputation = {};

        // Build reputation from actions
        for (const [sender, data] of Object.entries(actions.senderActions)) {
            reputation[sender] = {
                action: data.action,
                count: data.count,
                autoApply: data.autoApply,
                reputation: data.action === 'delete' ? 'ignore' :
                           data.action === 'archive' ? 'low-priority' :
                           data.action === 'star' ? 'important' :
                           data.action === 'reply' ? 'engage' : 'neutral'
            };
        }

        const summary = {
            important: Object.entries(reputation).filter(([_, r]) => r.reputation === 'important').length,
            engage: Object.entries(reputation).filter(([_, r]) => r.reputation === 'engage').length,
            lowPriority: Object.entries(reputation).filter(([_, r]) => r.reputation === 'low-priority').length,
            ignore: Object.entries(reputation).filter(([_, r]) => r.reputation === 'ignore').length
        };

        res.json({
            success: true,
            reputation,
            summary,
            topIgnored: Object.entries(reputation)
                .filter(([_, r]) => r.reputation === 'ignore')
                .slice(0, 5)
                .map(([sender]) => ({ sender, brandName: extractBrandName(sender) })),
            topImportant: Object.entries(reputation)
                .filter(([_, r]) => r.reputation === 'important' || r.reputation === 'engage')
                .slice(0, 5)
                .map(([sender]) => ({ sender, brandName: extractBrandName(sender) }))
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ TIME TRACKING ============

app.get('/api/analytics/response-times', (req, res) => {
    try {
        const actions = loadEmailActions();

        // Calculate average time to action
        const recentActions = actions.recentActions || [];

        // Group by action type
        const byAction = {};
        recentActions.forEach(a => {
            if (!byAction[a.action]) byAction[a.action] = 0;
            byAction[a.action]++;
        });

        res.json({
            success: true,
            analytics: {
                totalActions: recentActions.length,
                byAction,
                recentActivity: recentActions.slice(0, 10)
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SMART SCHEDULING ============

app.get('/api/scheduling/suggestions', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Find emails that might need follow-up or dedicated time
        const actionableEmails = db.prepare(`
            SELECT
                m.ROWID as id,
                s.subject,
                a.address as sender,
                datetime(m.date_received, 'unixepoch', 'localtime') as received
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-3 days')
            AND m.read = 0
            AND m.deleted = 0
            AND (
                s.subject LIKE '%meeting%'
                OR s.subject LIKE '%call%'
                OR s.subject LIKE '%review%'
                OR s.subject LIKE '%deadline%'
                OR s.subject LIKE '%urgent%'
                OR s.subject LIKE '%action%'
                OR s.subject LIKE '%request%'
            )
            ORDER BY m.date_received DESC
            LIMIT 10
        `).all();

        db.close();

        const suggestions = actionableEmails.map(email => {
            const subjectLower = (email.subject || '').toLowerCase();
            let suggestedDuration = 30;
            let suggestedType = 'Focus Time';

            if (subjectLower.includes('meeting') || subjectLower.includes('call')) {
                suggestedDuration = 60;
                suggestedType = 'Meeting Prep';
            } else if (subjectLower.includes('review')) {
                suggestedDuration = 45;
                suggestedType = 'Review Task';
            } else if (subjectLower.includes('urgent') || subjectLower.includes('deadline')) {
                suggestedDuration = 60;
                suggestedType = 'Priority Task';
            }

            return {
                emailId: email.id,
                subject: email.subject,
                sender: email.sender,
                suggestedBlock: {
                    duration: suggestedDuration,
                    type: suggestedType,
                    title: `${suggestedType}: ${email.subject?.substring(0, 30)}...`
                }
            };
        });

        res.json({
            success: true,
            suggestions,
            recommendedFocusTime: suggestions.length > 3 ? '2 hours' : '1 hour'
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ NOTIFICATIONS ============

app.get('/api/notifications/pending', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Check for urgent unread emails in last hour
        const urgent = db.prepare(`
            SELECT
                m.ROWID as id,
                s.subject,
                a.address as sender,
                datetime(m.date_received, 'unixepoch', 'localtime') as received
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-1 hour')
            AND m.read = 0
            AND m.deleted = 0
            AND (
                s.subject LIKE '%urgent%'
                OR s.subject LIKE '%URGENT%'
                OR s.subject LIKE '%action required%'
                OR s.subject LIKE '%immediate%'
                OR a.address LIKE '%bankofamerica%'
                OR a.address LIKE '%paypal%'
            )
            ORDER BY m.date_received DESC
            LIMIT 5
        `).all();

        db.close();

        res.json({
            success: true,
            notifications: urgent.map(e => ({
                id: e.id,
                title: 'Urgent Email',
                body: e.subject,
                sender: extractBrandName(e.sender),
                priority: 'high'
            }))
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ iOS SHORTCUTS INTEGRATION ============

app.get('/api/shortcuts/briefing', (req, res) => {
    // Simplified briefing for iOS shortcuts
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        const stats = db.prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread
            FROM messages
            WHERE date_received > strftime('%s', 'now', '-24 hours')
            AND deleted = 0
        `).get();

        db.close();

        const text = `You have ${stats.unread} unread emails out of ${stats.total} received today.`;

        res.json({
            success: true,
            text,
            unread: stats.unread,
            total: stats.total
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ EMAIL RULES SYSTEM ============

const RULES_FILE = path.join(__dirname, 'email-rules.json');

function loadRules() {
    try {
        if (fs.existsSync(RULES_FILE)) {
            return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { rules: [] };
}

function saveRules(rules) {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

app.get('/api/rules', (req, res) => {
    const data = loadRules();
    res.json({ success: true, rules: data.rules });
});

app.post('/api/rules', (req, res) => {
    try {
        const { name, conditions, actions, enabled = true } = req.body;
        const data = loadRules();
        const newId = Date.now();
        const rule = { id: newId, name, conditions, actions, enabled, createdAt: new Date().toISOString() };
        data.rules.push(rule);
        saveRules(data);
        res.json({ success: true, rule });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/rules/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const data = loadRules();
        const index = data.rules.findIndex(r => r.id === id);
        if (index >= 0) {
            data.rules[index] = { ...data.rules[index], ...req.body };
            saveRules(data);
            res.json({ success: true, rule: data.rules[index] });
        } else {
            res.status(404).json({ success: false, error: 'Rule not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/rules/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const data = loadRules();
        data.rules = data.rules.filter(r => r.id !== id);
        saveRules(data);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Apply rules to an email
app.post('/api/rules/apply', (req, res) => {
    try {
        const { email } = req.body;
        const data = loadRules();
        const matchedRules = [];

        for (const rule of data.rules.filter(r => r.enabled)) {
            let matches = true;
            for (const condition of rule.conditions) {
                const field = email[condition.field]?.toLowerCase() || '';
                const value = condition.value.toLowerCase();

                switch (condition.operator) {
                    case 'contains':
                        matches = matches && field.includes(value);
                        break;
                    case 'equals':
                        matches = matches && field === value;
                        break;
                    case 'startsWith':
                        matches = matches && field.startsWith(value);
                        break;
                    case 'endsWith':
                        matches = matches && field.endsWith(value);
                        break;
                }
            }
            if (matches) {
                matchedRules.push(rule);
            }
        }

        res.json({ success: true, matchedRules, suggestedActions: matchedRules.flatMap(r => r.actions) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SNOOZE SYSTEM ============

const SNOOZE_FILE = path.join(__dirname, 'snoozed-emails.json');

function loadSnoozed() {
    try {
        if (fs.existsSync(SNOOZE_FILE)) {
            return JSON.parse(fs.readFileSync(SNOOZE_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { snoozed: [] };
}

function saveSnoozed(data) {
    fs.writeFileSync(SNOOZE_FILE, JSON.stringify(data, null, 2));
}

app.post('/api/emails/snooze', (req, res) => {
    try {
        const { emailId, sender, subject, snoozeUntil, snoozeType } = req.body;
        const data = loadSnoozed();

        let wakeTime = new Date();
        switch (snoozeType) {
            case 'tonight':
                wakeTime.setHours(18, 0, 0, 0);
                break;
            case 'tomorrow':
                wakeTime.setDate(wakeTime.getDate() + 1);
                wakeTime.setHours(9, 0, 0, 0);
                break;
            case 'weekend':
                const daysUntilSat = (6 - wakeTime.getDay() + 7) % 7 || 7;
                wakeTime.setDate(wakeTime.getDate() + daysUntilSat);
                wakeTime.setHours(10, 0, 0, 0);
                break;
            case 'nextWeek':
                wakeTime.setDate(wakeTime.getDate() + (8 - wakeTime.getDay()) % 7);
                wakeTime.setHours(9, 0, 0, 0);
                break;
            case 'afterMeeting':
                // Get next calendar event end time
                wakeTime.setHours(wakeTime.getHours() + 1);
                break;
            case 'custom':
                wakeTime = new Date(snoozeUntil);
                break;
        }

        data.snoozed.push({
            emailId,
            sender,
            subject,
            snoozedAt: new Date().toISOString(),
            wakeTime: wakeTime.toISOString(),
            snoozeType
        });

        saveSnoozed(data);
        res.json({ success: true, wakeTime: wakeTime.toISOString() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/emails/snoozed', (req, res) => {
    const data = loadSnoozed();
    const now = new Date();
    const awakened = data.snoozed.filter(s => new Date(s.wakeTime) <= now);
    const stillSnoozed = data.snoozed.filter(s => new Date(s.wakeTime) > now);
    res.json({ success: true, awakened, snoozed: stillSnoozed });
});

// ============ CONTACT INTELLIGENCE ============

const CONTACTS_FILE = path.join(__dirname, 'contact-intelligence.json');

function loadContacts() {
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { contacts: {} };
}

function saveContacts(data) {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/contacts/intelligence', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });
        const contacts = loadContacts();

        // Get interaction data from emails
        const interactions = db.prepare(`
            SELECT
                a.address as email,
                COUNT(*) as total_emails,
                MAX(datetime(m.date_received, 'unixepoch', 'localtime')) as last_received,
                MIN(datetime(m.date_received, 'unixepoch', 'localtime')) as first_received
            FROM messages m
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-90 days')
            AND m.deleted = 0
            AND a.address IS NOT NULL
            GROUP BY a.address
            ORDER BY total_emails DESC
            LIMIT 50
        `).all();

        db.close();

        const now = new Date();
        const enriched = interactions.map(c => {
            const lastDate = new Date(c.last_received);
            const daysSince = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));

            let relationship = 'acquaintance';
            if (c.total_emails > 20) relationship = 'frequent';
            else if (c.total_emails > 10) relationship = 'regular';
            else if (c.total_emails > 5) relationship = 'occasional';

            let status = 'active';
            if (daysSince > 30) status = 'dormant';
            if (daysSince > 60) status = 'cold';

            return {
                email: c.email,
                name: extractBrandName(c.email),
                totalEmails: c.total_emails,
                lastContact: c.last_received,
                daysSinceContact: daysSince,
                relationship,
                status,
                needsFollowUp: daysSince > 14 && c.total_emails > 5
            };
        });

        // Find contacts that need attention
        const needsAttention = enriched.filter(c => c.needsFollowUp).slice(0, 5);

        res.json({
            success: true,
            contacts: enriched,
            needsAttention,
            summary: {
                frequent: enriched.filter(c => c.relationship === 'frequent').length,
                dormant: enriched.filter(c => c.status === 'dormant').length,
                cold: enriched.filter(c => c.status === 'cold').length
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ DAILY GOALS ============

const GOALS_FILE = path.join(__dirname, 'daily-goals.json');

function loadGoals() {
    try {
        if (fs.existsSync(GOALS_FILE)) {
            return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { goals: [], history: [] };
}

function saveGoals(data) {
    fs.writeFileSync(GOALS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/goals', (req, res) => {
    const data = loadGoals();
    const today = new Date().toISOString().split('T')[0];
    const todayGoals = data.goals.filter(g => g.date === today);
    res.json({ success: true, goals: todayGoals, history: data.history.slice(0, 7) });
});

app.post('/api/goals', (req, res) => {
    try {
        const { text } = req.body;
        const data = loadGoals();
        const today = new Date().toISOString().split('T')[0];
        const todayGoals = data.goals.filter(g => g.date === today);

        if (todayGoals.length >= 3) {
            return res.status(400).json({ success: false, error: 'Maximum 3 goals per day' });
        }

        const goal = {
            id: Date.now(),
            text,
            date: today,
            completed: false,
            createdAt: new Date().toISOString()
        };

        data.goals.push(goal);
        saveGoals(data);
        res.json({ success: true, goal });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/goals/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { completed } = req.body;
        const data = loadGoals();
        const goal = data.goals.find(g => g.id === id);

        if (goal) {
            goal.completed = completed;
            goal.completedAt = completed ? new Date().toISOString() : null;
            saveGoals(data);
            res.json({ success: true, goal });
        } else {
            res.status(404).json({ success: false, error: 'Goal not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ WEATHER & COMMUTE ============

app.get('/api/weather', async (req, res) => {
    try {
        // Use wttr.in for simple weather (no API key needed)
        const response = await fetch('https://wttr.in/?format=j1');
        const data = await response.json();

        const current = data.current_condition[0];
        const weather = {
            temp: current.temp_F,
            feelsLike: current.FeelsLikeF,
            condition: current.weatherDesc[0].value,
            humidity: current.humidity,
            icon: getWeatherIcon(current.weatherCode)
        };

        res.json({ success: true, weather });
    } catch (error) {
        // Fallback with mock data
        res.json({
            success: true,
            weather: {
                temp: '--',
                condition: 'Unable to fetch',
                icon: '☁️'
            }
        });
    }
});

function getWeatherIcon(code) {
    const icons = {
        '113': '☀️', '116': '⛅', '119': '☁️', '122': '☁️',
        '143': '🌫️', '176': '🌧️', '179': '🌨️', '182': '🌨️',
        '185': '🌨️', '200': '⛈️', '227': '❄️', '230': '❄️',
        '248': '🌫️', '260': '🌫️', '263': '🌧️', '266': '🌧️'
    };
    return icons[code] || '☁️';
}

// ============ SYSTEM STATUS ============

app.get('/api/system/status', (req, res) => {
    try {
        // Get disk space
        const diskInfo = execSync("df -h / | tail -1 | awk '{print $4, $5}'", { encoding: 'utf-8' }).trim().split(' ');
        const freeSpace = diskInfo[0];
        const usedPercent = parseInt(diskInfo[1]);

        // Get battery info (macOS)
        let battery = { level: 100, charging: false };
        try {
            const batteryInfo = execSync("pmset -g batt | grep -o '[0-9]*%' | head -1", { encoding: 'utf-8' }).trim();
            battery.level = parseInt(batteryInfo) || 100;
            battery.charging = execSync("pmset -g batt", { encoding: 'utf-8' }).includes('AC Power');
        } catch (e) {}

        // Get memory usage
        const memInfo = execSync("vm_stat | head -5", { encoding: 'utf-8' });

        // Check for Time Machine backup
        let lastBackup = 'Unknown';
        try {
            lastBackup = execSync("tmutil latestbackup 2>/dev/null | xargs -I {} stat -f '%Sm' {} 2>/dev/null || echo 'Not configured'", { encoding: 'utf-8' }).trim();
        } catch (e) {
            lastBackup = 'Not configured';
        }

        const alerts = [];
        if (usedPercent > 90) alerts.push({ type: 'critical', message: 'Disk space critically low!' });
        else if (usedPercent > 80) alerts.push({ type: 'warning', message: 'Disk space running low' });
        if (battery.level < 20 && !battery.charging) alerts.push({ type: 'warning', message: 'Battery low' });

        res.json({
            success: true,
            system: {
                disk: { freeSpace, usedPercent },
                battery,
                lastBackup,
                alerts
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ BILLABLE HOURS ============

const HOURS_FILE = path.join(__dirname, 'billable-hours.json');

function loadHours() {
    try {
        if (fs.existsSync(HOURS_FILE)) {
            return JSON.parse(fs.readFileSync(HOURS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { clients: [], entries: [] };
}

function saveHours(data) {
    fs.writeFileSync(HOURS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/hours', (req, res) => {
    const data = loadHours();
    const today = new Date().toISOString().split('T')[0];
    const todayEntries = data.entries.filter(e => e.date === today);
    const todayTotal = todayEntries.reduce((sum, e) => sum + e.minutes, 0);

    res.json({
        success: true,
        clients: data.clients,
        todayEntries,
        todayTotal,
        weekTotal: data.entries
            .filter(e => {
                const d = new Date(e.date);
                const now = new Date();
                const weekAgo = new Date(now.setDate(now.getDate() - 7));
                return d >= weekAgo;
            })
            .reduce((sum, e) => sum + e.minutes, 0)
    });
});

app.post('/api/hours', (req, res) => {
    try {
        const { client, minutes, description } = req.body;
        const data = loadHours();

        if (!data.clients.includes(client)) {
            data.clients.push(client);
        }

        const entry = {
            id: Date.now(),
            client,
            minutes,
            description,
            date: new Date().toISOString().split('T')[0],
            timestamp: new Date().toISOString()
        };

        data.entries.push(entry);
        saveHours(data);
        res.json({ success: true, entry });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ EMAIL RESPONSE TIME ============

app.get('/api/emails/response-insights', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Find emails that have been sitting unread
        const pendingEmails = db.prepare(`
            SELECT
                m.ROWID as id,
                s.subject,
                a.address as sender,
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                (strftime('%s', 'now') - m.date_received) / 3600 as hours_waiting
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.read = 0
            AND m.deleted = 0
            AND m.date_received > strftime('%s', 'now', '-14 days')
            ORDER BY m.date_received ASC
            LIMIT 20
        `).all();

        db.close();

        const insights = pendingEmails.map(e => {
            const hours = Math.round(e.hours_waiting);
            let urgency = 'normal';
            let message = '';

            if (hours > 72) {
                urgency = 'overdue';
                message = `Waiting ${Math.round(hours/24)} days — consider responding or archiving`;
            } else if (hours > 24) {
                urgency = 'attention';
                message = `${Math.round(hours/24)} day${hours > 48 ? 's' : ''} old`;
            } else {
                message = `${hours} hours`;
            }

            return {
                ...e,
                hoursWaiting: hours,
                urgency,
                insight: message
            };
        });

        const overdue = insights.filter(i => i.urgency === 'overdue');

        res.json({
            success: true,
            insights,
            overdue,
            avgResponseTime: Math.round(insights.reduce((sum, i) => sum + i.hoursWaiting, 0) / insights.length) || 0
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ VIP SENDERS ============

const VIP_FILE = path.join(__dirname, 'vip-senders.json');

function loadVIPs() {
    try {
        if (fs.existsSync(VIP_FILE)) {
            return JSON.parse(fs.readFileSync(VIP_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { vips: [] };
}

function saveVIPs(data) {
    fs.writeFileSync(VIP_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/vip', (req, res) => {
    const data = loadVIPs();
    res.json({ success: true, vips: data.vips });
});

app.post('/api/vip', (req, res) => {
    try {
        const { email, name } = req.body;
        const data = loadVIPs();
        if (!data.vips.find(v => v.email === email)) {
            data.vips.push({ email, name, addedAt: new Date().toISOString() });
            saveVIPs(data);
        }
        res.json({ success: true, vips: data.vips });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/vip/:email', (req, res) => {
    try {
        const email = decodeURIComponent(req.params.email);
        const data = loadVIPs();
        data.vips = data.vips.filter(v => v.email !== email);
        saveVIPs(data);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/vip/check', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });
        const vips = loadVIPs().vips;

        if (vips.length === 0) {
            return res.json({ success: true, vipEmails: [] });
        }

        const vipAddresses = vips.map(v => v.email.toLowerCase());
        const placeholders = vipAddresses.map(() => '?').join(',');

        const vipEmails = db.prepare(`
            SELECT
                m.ROWID as id,
                s.subject,
                a.address as sender,
                datetime(m.date_received, 'unixepoch', 'localtime') as received
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-1 hour')
            AND m.read = 0
            AND m.deleted = 0
            AND LOWER(a.address) IN (${placeholders})
        `).all(...vipAddresses);

        db.close();

        res.json({ success: true, vipEmails });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ATTACHMENT SCANNER ============

app.get('/api/attachments/pending', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Find emails with attachments that haven't been read
        const withAttachments = db.prepare(`
            SELECT
                m.ROWID as id,
                s.subject,
                a.address as sender,
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                m.attachment_count
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.read = 0
            AND m.deleted = 0
            AND m.attachment_count > 0
            AND m.date_received > strftime('%s', 'now', '-30 days')
            ORDER BY m.date_received DESC
            LIMIT 20
        `).all();

        db.close();

        const totalAttachments = withAttachments.reduce((sum, e) => sum + (e.attachment_count || 0), 0);

        res.json({
            success: true,
            emails: withAttachments,
            totalEmails: withAttachments.length,
            totalAttachments
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ WEEKEND MODE ============

const SETTINGS_FILE = path.join(__dirname, 'felix-settings.json');

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        weekendMode: { enabled: true, autoEnable: true },
        focusHours: { start: 9, end: 17 },
        notifications: { vipOnly: false, quietHours: { start: 22, end: 7 } }
    };
}

function saveSettings(data) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/settings', (req, res) => {
    const settings = loadSettings();
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const weekendModeActive = settings.weekendMode.autoEnable && isWeekend;

    res.json({ success: true, settings, weekendModeActive, isWeekend });
});

app.put('/api/settings', (req, res) => {
    try {
        const settings = loadSettings();
        Object.assign(settings, req.body);
        saveSettings(settings);
        res.json({ success: true, settings });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ MEETING PREP ============

app.get('/api/meetings/prep', (req, res) => {
    try {
        // Get upcoming meetings in next 2 hours
        const script = `
            set now to current date
            set twoHours to now + (2 * hours)
            set output to ""
            tell application "Calendar"
                repeat with cal in calendars
                    try
                        set evts to (every event of cal whose start date >= now and start date <= twoHours)
                        repeat with evt in evts
                            set evtStart to start date of evt
                            set evtSummary to summary of evt
                            set evtNotes to description of evt
                            set output to output & evtSummary & "|||" & (evtStart as string) & "|||" & evtNotes & "\\n"
                        end repeat
                    end try
                end repeat
            end tell
            return output
        `;

        const result = runAppleScript(script);
        const meetings = result.split('\n').filter(l => l.trim()).map(line => {
            const [title, dateStr, notes] = line.split('|||');
            return { title: title?.trim(), date: dateStr?.trim(), notes: notes?.trim() || '' };
        });

        // For each meeting, find relevant emails
        const db = new Database(MAIL_DB_PATH, { readonly: true });
        const preppedMeetings = meetings.map(meeting => {
            // Extract potential attendee names from meeting title
            const keywords = (meeting.title || '').split(/[\s,]+/).filter(w => w.length > 3);

            let relevantEmails = [];
            if (keywords.length > 0) {
                const searchTerm = `%${keywords[0]}%`;
                relevantEmails = db.prepare(`
                    SELECT
                        s.subject,
                        a.address as sender,
                        datetime(m.date_received, 'unixepoch', 'localtime') as received
                    FROM messages m
                    LEFT JOIN subjects s ON m.subject = s.ROWID
                    LEFT JOIN addresses a ON m.sender = a.ROWID
                    WHERE m.date_received > strftime('%s', 'now', '-14 days')
                    AND m.deleted = 0
                    AND (s.subject LIKE ? OR a.address LIKE ?)
                    ORDER BY m.date_received DESC
                    LIMIT 5
                `).all(searchTerm, searchTerm);
            }

            return { ...meeting, relevantEmails };
        });

        db.close();

        res.json({ success: true, meetings: preppedMeetings });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ AI-POWERED RESPONSES (Claude API) ============

async function callClaude(prompt, context = '') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY not set');
    }

    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            messages: [
                {
                    role: 'user',
                    content: `You are Felix, an AI executive assistant helping compose professional email responses. Be concise, professional, and match the tone of the original email. ${context}\n\n${prompt}`
                }
            ]
        });

        const options = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    if (response.content && response.content[0]) {
                        resolve(response.content[0].text);
                    } else {
                        reject(new Error(response.error?.message || 'Unknown API error'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// Draft an email reply
app.post('/api/ai/draft-reply', async (req, res) => {
    try {
        const { originalEmail, tone = 'professional', instruction = '' } = req.body;

        const prompt = `Draft a reply to this email:

From: ${originalEmail.sender}
Subject: ${originalEmail.subject}
Body: ${originalEmail.body || '(Email body not available)'}

${instruction ? `Additional instruction: ${instruction}` : ''}
Tone: ${tone}

Write only the reply body, no subject line or signature.`;

        const draft = await callClaude(prompt);
        res.json({ success: true, draft });

    } catch (error) {
        console.error('AI draft error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            fallback: "I'd be happy to help draft a response. Could you tell me the key points you'd like to address?"
        });
    }
});

// Summarize an email thread
app.post('/api/ai/summarize', async (req, res) => {
    try {
        const { emails } = req.body;

        const prompt = `Summarize this email thread in 2-3 bullet points. Focus on key decisions, action items, and deadlines:

${emails.map((e, i) => `Email ${i + 1}:\nFrom: ${e.sender}\nSubject: ${e.subject}\n${e.body || ''}`).join('\n\n')}`;

        const summary = await callClaude(prompt);
        res.json({ success: true, summary });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Suggest quick actions for an email
app.post('/api/ai/suggest-action', async (req, res) => {
    try {
        const { email } = req.body;

        const prompt = `Based on this email, suggest the best action (reply, archive, delete, schedule meeting, create task, or forward). Respond with JSON: {"action": "...", "reason": "...", "urgency": "high/medium/low"}

From: ${email.sender}
Subject: ${email.subject}
Preview: ${(email.body || '').substring(0, 200)}`;

        const response = await callClaude(prompt);
        const suggestion = JSON.parse(response);
        res.json({ success: true, suggestion });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SLACK INTEGRATION ============

const SLACK_FILE = path.join(__dirname, 'slack-config.json');

function loadSlackConfig() {
    try {
        if (fs.existsSync(SLACK_FILE)) {
            return JSON.parse(fs.readFileSync(SLACK_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { token: null, userId: null, connected: false };
}

function saveSlackConfig(config) {
    fs.writeFileSync(SLACK_FILE, JSON.stringify(config, null, 2));
}

// Connect Slack
app.post('/api/slack/connect', (req, res) => {
    try {
        const { token } = req.body;
        const config = { token, connected: true, connectedAt: new Date().toISOString() };
        saveSlackConfig(config);
        res.json({ success: true, message: 'Slack connected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get Slack status
app.get('/api/slack/status', (req, res) => {
    const config = loadSlackConfig();
    res.json({ success: true, connected: config.connected });
});

// Set Slack status based on calendar/focus mode
app.post('/api/slack/set-status', async (req, res) => {
    try {
        const config = loadSlackConfig();
        if (!config.token) {
            return res.json({ success: false, error: 'Slack not connected' });
        }

        const { status, emoji, expiration } = req.body;

        const data = JSON.stringify({
            profile: {
                status_text: status,
                status_emoji: emoji || ':calendar:',
                status_expiration: expiration || 0
            }
        });

        const options = {
            hostname: 'slack.com',
            port: 443,
            path: '/api/users.profile.set',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.token}`,
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const slackReq = https.request(options, (slackRes) => {
            let body = '';
            slackRes.on('data', chunk => body += chunk);
            slackRes.on('end', () => {
                const response = JSON.parse(body);
                res.json({ success: response.ok, response });
            });
        });

        slackReq.on('error', (e) => {
            res.status(500).json({ success: false, error: e.message });
        });

        slackReq.write(data);
        slackReq.end();

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get recent Slack DMs
app.get('/api/slack/messages', async (req, res) => {
    try {
        const config = loadSlackConfig();
        if (!config.token) {
            return res.json({ success: false, error: 'Slack not connected', messages: [] });
        }

        // This would fetch from Slack API - simplified for now
        res.json({
            success: true,
            messages: [],
            note: 'Connect Slack with OAuth to see DMs'
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Auto-sync status with calendar
app.get('/api/slack/sync-calendar', async (req, res) => {
    try {
        const config = loadSlackConfig();
        if (!config.token) {
            return res.json({ success: false, error: 'Slack not connected' });
        }

        // Check current calendar
        const script = `
            set now to current date
            set inMeeting to false
            set meetingName to ""
            tell application "Calendar"
                repeat with cal in calendars
                    try
                        set evts to (every event of cal whose start date <= now and end date >= now)
                        if (count of evts) > 0 then
                            set inMeeting to true
                            set meetingName to summary of item 1 of evts
                        end if
                    end try
                end repeat
            end tell
            if inMeeting then
                return "IN_MEETING:" & meetingName
            else
                return "AVAILABLE"
            end if
        `;

        const result = runAppleScript(script);

        if (result.startsWith('IN_MEETING:')) {
            const meetingName = result.replace('IN_MEETING:', '');
            // Set Slack status to in meeting
            res.json({
                success: true,
                status: 'in_meeting',
                meeting: meetingName,
                suggestedStatus: `In a meeting: ${meetingName.substring(0, 30)}`
            });
        } else {
            res.json({ success: true, status: 'available' });
        }

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ PWA SUPPORT ============

// Serve manifest
app.get('/manifest.json', (req, res) => {
    res.json({
        name: 'Felix - AI Chief of Staff',
        short_name: 'Felix',
        description: 'Your local AI executive assistant',
        start_url: '/',
        display: 'standalone',
        background_color: '#f8f9fc',
        theme_color: '#b8935a',
        icons: [
            {
                src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23b8935a" width="100" height="100" rx="20"/><text x="50" y="65" font-size="50" text-anchor="middle" fill="white" font-family="serif">F</text></svg>',
                sizes: '192x192',
                type: 'image/svg+xml',
                purpose: 'any maskable'
            }
        ]
    });
});

// Service worker
app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
        const CACHE_NAME = 'felix-v1';
        const ASSETS = ['/', '/index.html'];

        self.addEventListener('install', (e) => {
            e.waitUntil(
                caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
            );
        });

        self.addEventListener('fetch', (e) => {
            // Network first, fallback to cache
            e.respondWith(
                fetch(e.request)
                    .catch(() => caches.match(e.request))
            );
        });

        self.addEventListener('push', (e) => {
            const data = e.data?.json() || { title: 'Felix', body: 'New notification' };
            e.waitUntil(
                self.registration.showNotification(data.title, {
                    body: data.body,
                    icon: '/manifest.json',
                    badge: '/manifest.json'
                })
            );
        });
    `);
});

// ============ EMAIL PREVIEW (Full Body) ============

app.get('/api/emails/:id/preview', (req, res) => {
    try {
        const emailId = parseInt(req.params.id);
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Get email with full details
        const email = db.prepare(`
            SELECT
                m.ROWID as id,
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                s.subject,
                a.address as sender,
                m.read,
                m.flagged,
                m.snippet
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.ROWID = ?
        `).get(emailId);

        db.close();

        if (!email) {
            return res.status(404).json({ success: false, error: 'Email not found' });
        }

        // The snippet field contains preview text
        // For full body, we'd need to access the actual message files
        // For now, return what we have
        res.json({
            success: true,
            email: {
                ...email,
                body: email.snippet || '(Email body not available in database. Open in Mail app for full content.)',
                bodyHtml: null
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ CALENDAR CREATE ============

app.post('/api/calendar/create', (req, res) => {
    try {
        const { title, date, duration = 60, notes = '', calendar = '' } = req.body;

        // Format date for AppleScript
        const eventDate = new Date(date);
        const endDate = new Date(eventDate.getTime() + duration * 60000);

        const script = `
            set eventTitle to "${title.replace(/"/g, '\\"')}"
            set eventNotes to "${notes.replace(/"/g, '\\"')}"
            set startDate to date "${eventDate.toLocaleString('en-US')}"
            set endDate to date "${endDate.toLocaleString('en-US')}"

            tell application "Calendar"
                tell calendar "${calendar || 'Calendar'}"
                    set newEvent to make new event with properties {summary:eventTitle, start date:startDate, end date:endDate, description:eventNotes}
                end tell
            end tell
            return "success"
        `;

        const result = runAppleScript(script);

        res.json({
            success: result.includes('success'),
            message: 'Event created in Calendar',
            event: { title, date, duration }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get available calendars
app.get('/api/calendar/list', (req, res) => {
    try {
        const script = `
            set calList to ""
            tell application "Calendar"
                repeat with cal in calendars
                    set calList to calList & name of cal & "|||"
                end repeat
            end tell
            return calList
        `;

        const result = runAppleScript(script);
        const calendars = result.split('|||').filter(c => c.trim());

        res.json({ success: true, calendars });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ REORDER RULES ============

app.put('/api/rules/reorder', (req, res) => {
    try {
        const { ruleIds } = req.body; // Array of IDs in new order
        const data = loadRules();

        // Reorder rules based on provided IDs
        const reordered = ruleIds.map(id => data.rules.find(r => r.id === id)).filter(Boolean);

        // Add any rules not in the list (shouldn't happen, but safety)
        const remaining = data.rules.filter(r => !ruleIds.includes(r.id));

        data.rules = [...reordered, ...remaining];
        saveRules(data);

        res.json({ success: true, rules: data.rules });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ THEME SETTINGS ============

app.get('/api/theme', (req, res) => {
    const settings = loadSettings();
    res.json({ success: true, theme: settings.theme || 'light' });
});

app.put('/api/theme', (req, res) => {
    try {
        const { theme } = req.body;
        const settings = loadSettings();
        settings.theme = theme;
        saveSettings(settings);
        res.json({ success: true, theme });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ PRODUCTIVITY SCORE ============

const PRODUCTIVITY_FILE = path.join(__dirname, 'productivity-data.json');

function loadProductivity() {
    try {
        if (fs.existsSync(PRODUCTIVITY_FILE)) {
            return JSON.parse(fs.readFileSync(PRODUCTIVITY_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        inboxZeroStreak: 0,
        lastInboxZero: null,
        dailyStats: {},
        weeklyScores: []
    };
}

function saveProductivity(data) {
    fs.writeFileSync(PRODUCTIVITY_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/productivity/score', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });
        const productivity = loadProductivity();
        const actions = loadEmailActions();
        const goals = loadGoals();

        // Calculate metrics
        const today = new Date().toISOString().split('T')[0];

        // Emails processed today
        const todayActions = (actions.recentActions || []).filter(a =>
            a.timestamp?.startsWith(today)
        ).length;

        // Unread count
        const unreadStats = db.prepare(`
            SELECT COUNT(*) as unread
            FROM messages
            WHERE read = 0 AND deleted = 0
            AND date_received > strftime('%s', 'now', '-7 days')
        `).get();

        // Response time (avg hours to action)
        const avgResponseTime = db.prepare(`
            SELECT AVG((strftime('%s', 'now') - date_received) / 3600) as avg_hours
            FROM messages
            WHERE read = 0 AND deleted = 0
            AND date_received > strftime('%s', 'now', '-7 days')
        `).get();

        db.close();

        // Goals completed today
        const todayGoals = goals.goals?.filter(g => g.date === today) || [];
        const goalsCompleted = todayGoals.filter(g => g.completed).length;
        const goalsTotal = todayGoals.length;

        // Calculate score (0-100)
        let score = 50; // Base score

        // Inbox management (+/- 20)
        if (unreadStats.unread < 10) score += 20;
        else if (unreadStats.unread < 25) score += 10;
        else if (unreadStats.unread > 100) score -= 20;
        else if (unreadStats.unread > 50) score -= 10;

        // Actions taken (+15)
        if (todayActions > 20) score += 15;
        else if (todayActions > 10) score += 10;
        else if (todayActions > 5) score += 5;

        // Goals (+15)
        if (goalsTotal > 0) {
            score += Math.round((goalsCompleted / goalsTotal) * 15);
        }

        // Response time (+/- 10)
        const avgHours = avgResponseTime.avg_hours || 0;
        if (avgHours < 4) score += 10;
        else if (avgHours < 12) score += 5;
        else if (avgHours > 48) score -= 10;

        // Check for inbox zero
        const isInboxZero = unreadStats.unread === 0;
        if (isInboxZero) {
            if (!productivity.lastInboxZero || productivity.lastInboxZero !== today) {
                productivity.inboxZeroStreak++;
                productivity.lastInboxZero = today;
                saveProductivity(productivity);
            }
            score += 10;
        }

        // Clamp score
        score = Math.max(0, Math.min(100, score));

        // Determine grade
        let grade = 'C';
        if (score >= 90) grade = 'A+';
        else if (score >= 80) grade = 'A';
        else if (score >= 70) grade = 'B';
        else if (score >= 60) grade = 'B-';
        else if (score >= 50) grade = 'C';
        else if (score >= 40) grade = 'C-';
        else grade = 'D';

        res.json({
            success: true,
            score,
            grade,
            metrics: {
                unreadEmails: unreadStats.unread,
                actionsToday: todayActions,
                goalsCompleted,
                goalsTotal,
                avgResponseHours: Math.round(avgHours),
                inboxZeroStreak: productivity.inboxZeroStreak,
                isInboxZero
            },
            tips: generateProductivityTips(score, unreadStats.unread, todayActions, avgHours)
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

function generateProductivityTips(score, unread, actions, avgHours) {
    const tips = [];

    if (unread > 50) {
        tips.push({ type: 'warning', text: 'High unread count. Consider batch processing or creating more rules.' });
    }
    if (actions < 5) {
        tips.push({ type: 'suggestion', text: 'Process at least 10 emails to boost your score.' });
    }
    if (avgHours > 24) {
        tips.push({ type: 'warning', text: 'Some emails waiting 24+ hours. Check for buried priorities.' });
    }
    if (score >= 80) {
        tips.push({ type: 'success', text: 'Excellent email management! Keep it up.' });
    }

    return tips;
}

// ============ WEEKLY REPORT ============

app.get('/api/report/weekly', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });
        const actions = loadEmailActions();
        const goals = loadGoals();
        const hours = loadHours();

        // This week's stats
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - 7);
        const weekStartStr = weekStart.toISOString().split('T')[0];

        // Email stats
        const emailStats = db.prepare(`
            SELECT
                COUNT(*) as received,
                SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as read_count,
                SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) as deleted
            FROM messages
            WHERE date_received > strftime('%s', 'now', '-7 days')
        `).get();

        // Top senders
        const topSenders = db.prepare(`
            SELECT a.address, COUNT(*) as count
            FROM messages m
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.date_received > strftime('%s', 'now', '-7 days')
            AND m.deleted = 0
            GROUP BY a.address
            ORDER BY count DESC
            LIMIT 5
        `).all();

        db.close();

        // Actions this week
        const weekActions = (actions.recentActions || []).filter(a =>
            a.timestamp >= weekStartStr
        );
        const actionCounts = {};
        weekActions.forEach(a => {
            actionCounts[a.action] = (actionCounts[a.action] || 0) + 1;
        });

        // Goals this week
        const weekGoals = (goals.goals || []).filter(g => g.date >= weekStartStr);
        const goalsCompleted = weekGoals.filter(g => g.completed).length;

        // Hours this week
        const weekHours = (hours.entries || [])
            .filter(e => e.date >= weekStartStr)
            .reduce((sum, e) => sum + e.minutes, 0);

        // Build report
        const report = {
            period: `${weekStart.toLocaleDateString()} - ${new Date().toLocaleDateString()}`,
            summary: {
                emailsReceived: emailStats.received,
                emailsRead: emailStats.read_count,
                readRate: Math.round((emailStats.read_count / emailStats.received) * 100) || 0,
                actionsTotal: weekActions.length,
                goalsSet: weekGoals.length,
                goalsCompleted,
                hoursLogged: Math.round(weekHours / 60 * 10) / 10
            },
            actionBreakdown: actionCounts,
            topSenders: topSenders.map(s => ({
                sender: extractBrandName(s.address),
                email: s.address,
                count: s.count
            })),
            highlights: [],
            areasToImprove: []
        };

        // Generate highlights
        if (report.summary.readRate > 70) {
            report.highlights.push('Great read rate - staying on top of inbox');
        }
        if (goalsCompleted >= weekGoals.length * 0.8 && weekGoals.length > 0) {
            report.highlights.push(`Completed ${goalsCompleted}/${weekGoals.length} goals`);
        }
        if (actionCounts.archive > 20) {
            report.highlights.push('Active inbox management with archiving');
        }

        // Areas to improve
        if (report.summary.readRate < 50) {
            report.areasToImprove.push('Low read rate - consider more aggressive filtering');
        }
        if (weekGoals.length === 0) {
            report.areasToImprove.push('No goals set - try setting daily priorities');
        }

        res.json({ success: true, report });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate email report (could be sent via email)
app.post('/api/report/send', async (req, res) => {
    try {
        // Get weekly report
        const reportRes = await fetch(`http://localhost:${PORT}/api/report/weekly`);
        const reportData = await reportRes.json();

        if (!reportData.success) {
            return res.status(500).json({ success: false, error: 'Could not generate report' });
        }

        const report = reportData.report;

        // Format as text for email/notification
        const reportText = `
Felix Weekly Report
${report.period}

📊 SUMMARY
• Emails received: ${report.summary.emailsReceived}
• Read rate: ${report.summary.readRate}%
• Actions taken: ${report.summary.actionsTotal}
• Goals completed: ${report.summary.goalsCompleted}/${report.summary.goalsSet}
• Hours logged: ${report.summary.hoursLogged}h

🏆 HIGHLIGHTS
${report.highlights.map(h => '• ' + h).join('\n') || '• Keep working on your email habits!'}

📈 AREAS TO IMPROVE
${report.areasToImprove.map(a => '• ' + a).join('\n') || '• Doing great!'}

Top Senders: ${report.topSenders.slice(0, 3).map(s => s.sender).join(', ')}
        `.trim();

        res.json({
            success: true,
            reportText,
            message: 'Report generated. Copy to share or view in dashboard.'
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ TIME BLOCKING ============

app.get('/api/timeblocking/suggestions', (req, res) => {
    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        // Analyze email workload
        const pendingEmails = db.prepare(`
            SELECT COUNT(*) as count,
                   SUM(CASE WHEN s.subject LIKE '%urgent%' OR s.subject LIKE '%asap%' THEN 1 ELSE 0 END) as urgent
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            WHERE m.read = 0 AND m.deleted = 0
            AND m.date_received > strftime('%s', 'now', '-7 days')
        `).get();

        // Get current calendar to find free slots
        const calendarScript = `
            set today to current date
            set endOfDay to today + (1 * days)
            set busySlots to ""
            tell application "Calendar"
                repeat with cal in calendars
                    try
                        set evts to (every event of cal whose start date >= today and start date <= endOfDay)
                        repeat with evt in evts
                            set busySlots to busySlots & (start date of evt as string) & "|||" & (end date of evt as string) & "\\n"
                        end repeat
                    end try
                end repeat
            end tell
            return busySlots
        `;

        db.close();

        const busyResult = runAppleScript(calendarScript);
        const busySlots = busyResult.split('\n').filter(l => l.trim()).map(line => {
            const [start, end] = line.split('|||');
            return { start: new Date(start), end: new Date(end) };
        });

        // Calculate suggested blocks
        const suggestions = [];
        const now = new Date();
        const endOfDay = new Date(now);
        endOfDay.setHours(18, 0, 0, 0);

        // Email processing block
        if (pendingEmails.count > 20) {
            suggestions.push({
                type: 'email_processing',
                title: 'Email Processing',
                duration: 60,
                reason: `${pendingEmails.count} unread emails need attention`,
                priority: pendingEmails.urgent > 0 ? 'high' : 'medium',
                suggestedTime: findNextFreeSlot(now, busySlots, 60)
            });
        } else if (pendingEmails.count > 0) {
            suggestions.push({
                type: 'email_processing',
                title: 'Quick Email Check',
                duration: 30,
                reason: `${pendingEmails.count} emails to review`,
                priority: 'low',
                suggestedTime: findNextFreeSlot(now, busySlots, 30)
            });
        }

        // Focus time block
        suggestions.push({
            type: 'focus_time',
            title: 'Deep Work Block',
            duration: 90,
            reason: 'Protected time for important tasks',
            priority: 'high',
            suggestedTime: findNextFreeSlot(now, busySlots, 90)
        });

        // End of day review
        const reviewTime = new Date(now);
        reviewTime.setHours(17, 0, 0, 0);
        if (now < reviewTime) {
            suggestions.push({
                type: 'review',
                title: 'Daily Review',
                duration: 15,
                reason: 'Review progress and plan tomorrow',
                priority: 'medium',
                suggestedTime: reviewTime.toISOString()
            });
        }

        res.json({
            success: true,
            suggestions,
            workload: {
                pendingEmails: pendingEmails.count,
                urgentEmails: pendingEmails.urgent,
                recommendedEmailTime: pendingEmails.count > 30 ? '1.5 hours' : pendingEmails.count > 10 ? '45 min' : '20 min'
            }
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

function findNextFreeSlot(startFrom, busySlots, durationMinutes) {
    let candidate = new Date(startFrom);
    candidate.setMinutes(Math.ceil(candidate.getMinutes() / 15) * 15); // Round to 15 min

    const endOfDay = new Date(candidate);
    endOfDay.setHours(18, 0, 0, 0);

    while (candidate < endOfDay) {
        const candidateEnd = new Date(candidate.getTime() + durationMinutes * 60000);

        const conflict = busySlots.some(slot =>
            (candidate >= slot.start && candidate < slot.end) ||
            (candidateEnd > slot.start && candidateEnd <= slot.end)
        );

        if (!conflict) {
            return candidate.toISOString();
        }

        candidate = new Date(candidate.getTime() + 15 * 60000); // Try 15 min later
    }

    return null; // No slot found today
}

// Create time block in calendar
app.post('/api/timeblocking/create', (req, res) => {
    try {
        const { title, startTime, duration, calendar = '' } = req.body;

        const start = new Date(startTime);
        const end = new Date(start.getTime() + duration * 60000);

        const script = `
            set eventTitle to "${title.replace(/"/g, '\\"')}"
            set startDate to date "${start.toLocaleString('en-US')}"
            set endDate to date "${end.toLocaleString('en-US')}"

            tell application "Calendar"
                tell calendar "${calendar || 'Calendar'}"
                    make new event with properties {summary:eventTitle, start date:startDate, end date:endDate}
                end tell
            end tell
            return "success"
        `;

        const result = runAppleScript(script);

        res.json({
            success: result.includes('success'),
            message: `Time block "${title}" created`
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ NOTION INTEGRATION ============

const NOTION_FILE = path.join(__dirname, 'notion-config.json');

function loadNotionConfig() {
    try {
        if (fs.existsSync(NOTION_FILE)) {
            return JSON.parse(fs.readFileSync(NOTION_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { token: null, databaseId: null, connected: false };
}

function saveNotionConfig(config) {
    fs.writeFileSync(NOTION_FILE, JSON.stringify(config, null, 2));
}

app.get('/api/notion/status', (req, res) => {
    const config = loadNotionConfig();
    res.json({ success: true, connected: config.connected });
});

app.post('/api/notion/connect', (req, res) => {
    try {
        const { token, databaseId } = req.body;
        const config = { token, databaseId, connected: true, connectedAt: new Date().toISOString() };
        saveNotionConfig(config);
        res.json({ success: true, message: 'Notion connected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/notion/create-task', async (req, res) => {
    try {
        const config = loadNotionConfig();
        if (!config.token || !config.databaseId) {
            return res.json({ success: false, error: 'Notion not configured' });
        }

        const { title, emailSubject, emailSender, dueDate, priority = 'Medium' } = req.body;

        const data = JSON.stringify({
            parent: { database_id: config.databaseId },
            properties: {
                Name: { title: [{ text: { content: title } }] },
                'Email Subject': { rich_text: [{ text: { content: emailSubject || '' } }] },
                'From': { rich_text: [{ text: { content: emailSender || '' } }] },
                'Priority': { select: { name: priority } },
                'Due Date': dueDate ? { date: { start: dueDate } } : undefined,
                'Source': { select: { name: 'Felix' } }
            }
        });

        const options = {
            hostname: 'api.notion.com',
            port: 443,
            path: '/v1/pages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.token}`,
                'Notion-Version': '2022-06-28',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const notionReq = https.request(options, (notionRes) => {
            let body = '';
            notionRes.on('data', chunk => body += chunk);
            notionRes.on('end', () => {
                const response = JSON.parse(body);
                if (response.id) {
                    res.json({ success: true, pageId: response.id, url: response.url });
                } else {
                    res.json({ success: false, error: response.message || 'Failed to create' });
                }
            });
        });

        notionReq.on('error', (e) => {
            res.status(500).json({ success: false, error: e.message });
        });

        notionReq.write(data);
        notionReq.end();

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ LINEAR INTEGRATION ============

const LINEAR_FILE = path.join(__dirname, 'linear-config.json');

function loadLinearConfig() {
    try {
        if (fs.existsSync(LINEAR_FILE)) {
            return JSON.parse(fs.readFileSync(LINEAR_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { token: null, teamId: null, connected: false };
}

function saveLinearConfig(config) {
    fs.writeFileSync(LINEAR_FILE, JSON.stringify(config, null, 2));
}

app.get('/api/linear/status', (req, res) => {
    const config = loadLinearConfig();
    res.json({ success: true, connected: config.connected });
});

app.post('/api/linear/connect', (req, res) => {
    try {
        const { token, teamId } = req.body;
        const config = { token, teamId, connected: true, connectedAt: new Date().toISOString() };
        saveLinearConfig(config);
        res.json({ success: true, message: 'Linear connected' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/linear/create-issue', async (req, res) => {
    try {
        const config = loadLinearConfig();
        if (!config.token || !config.teamId) {
            return res.json({ success: false, error: 'Linear not configured' });
        }

        const { title, description, priority = 3 } = req.body;

        const query = `
            mutation CreateIssue($title: String!, $description: String, $teamId: String!, $priority: Int) {
                issueCreate(input: { title: $title, description: $description, teamId: $teamId, priority: $priority }) {
                    success
                    issue { id identifier url title }
                }
            }
        `;

        const data = JSON.stringify({
            query,
            variables: { title, description, teamId: config.teamId, priority }
        });

        const options = {
            hostname: 'api.linear.app',
            port: 443,
            path: '/graphql',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': config.token,
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const linearReq = https.request(options, (linearRes) => {
            let body = '';
            linearRes.on('data', chunk => body += chunk);
            linearRes.on('end', () => {
                const response = JSON.parse(body);
                if (response.data?.issueCreate?.success) {
                    const issue = response.data.issueCreate.issue;
                    res.json({ success: true, issue });
                } else {
                    res.json({ success: false, error: response.errors?.[0]?.message || 'Failed' });
                }
            });
        });

        linearReq.on('error', (e) => {
            res.status(500).json({ success: false, error: e.message });
        });

        linearReq.write(data);
        linearReq.end();

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ GITHUB ISSUES ============

app.post('/api/github/create-issue', async (req, res) => {
    try {
        const { repo, title, body, labels = [] } = req.body;
        const token = process.env.GITHUB_TOKEN;

        if (!token) {
            return res.json({ success: false, error: 'GITHUB_TOKEN not set' });
        }

        const data = JSON.stringify({ title, body, labels });

        const [owner, repoName] = repo.split('/');

        const options = {
            hostname: 'api.github.com',
            port: 443,
            path: `/repos/${owner}/${repoName}/issues`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Felix-Dashboard',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const ghReq = https.request(options, (ghRes) => {
            let body = '';
            ghRes.on('data', chunk => body += chunk);
            ghRes.on('end', () => {
                const response = JSON.parse(body);
                if (response.id) {
                    res.json({ success: true, issue: { id: response.id, number: response.number, url: response.html_url } });
                } else {
                    res.json({ success: false, error: response.message || 'Failed' });
                }
            });
        });

        ghReq.on('error', (e) => {
            res.status(500).json({ success: false, error: e.message });
        });

        ghReq.write(data);
        ghReq.end();

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ZAPIER WEBHOOKS ============

const WEBHOOKS_FILE = path.join(__dirname, 'webhooks-config.json');

function loadWebhooks() {
    try {
        if (fs.existsSync(WEBHOOKS_FILE)) {
            return JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { webhooks: [] };
}

function saveWebhooks(data) {
    fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/webhooks', (req, res) => {
    const data = loadWebhooks();
    res.json({ success: true, webhooks: data.webhooks });
});

app.post('/api/webhooks', (req, res) => {
    try {
        const { name, url, trigger, enabled = true } = req.body;
        const data = loadWebhooks();

        const webhook = {
            id: Date.now(),
            name,
            url,
            trigger, // 'email_received', 'email_action', 'goal_completed', 'inbox_zero'
            enabled,
            createdAt: new Date().toISOString()
        };

        data.webhooks.push(webhook);
        saveWebhooks(data);

        res.json({ success: true, webhook });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/webhooks/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const data = loadWebhooks();
        data.webhooks = data.webhooks.filter(w => w.id !== id);
        saveWebhooks(data);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Trigger webhooks
async function triggerWebhooks(triggerType, payload) {
    const data = loadWebhooks();
    const webhooks = data.webhooks.filter(w => w.enabled && w.trigger === triggerType);

    for (const webhook of webhooks) {
        try {
            const url = new URL(webhook.url);
            const postData = JSON.stringify({
                trigger: triggerType,
                timestamp: new Date().toISOString(),
                ...payload
            });

            const options = {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = https.request(options);
            req.write(postData);
            req.end();
        } catch (e) {
            console.error(`Webhook ${webhook.name} failed:`, e.message);
        }
    }
}

// Test webhook
app.post('/api/webhooks/:id/test', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const data = loadWebhooks();
        const webhook = data.webhooks.find(w => w.id === id);

        if (!webhook) {
            return res.status(404).json({ success: false, error: 'Webhook not found' });
        }

        await triggerWebhooks(webhook.trigger, { test: true, webhookId: id });
        res.json({ success: true, message: 'Test webhook sent' });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ADVANCED AI: THREAD SUMMARIZER ============

app.post('/api/ai/summarize-thread', async (req, res) => {
    const { emails } = req.body;

    if (!emails || emails.length === 0) {
        return res.status(400).json({ success: false, error: 'No emails provided' });
    }

    const settings = loadSettings();
    if (!settings.claudeApiKey) {
        // Return a mock summary if no API key
        const participantSet = new Set();
        emails.forEach(e => {
            if (e.sender) participantSet.add(e.sender.split('@')[0]);
        });

        return res.json({
            success: true,
            summary: {
                headline: `Thread with ${emails.length} messages`,
                keyPoints: [
                    'Multiple exchanges between participants',
                    emails[0]?.subject || 'Discussion thread',
                    `Last message: ${emails[emails.length - 1]?.preview || 'Recent reply'}`
                ],
                participants: Array.from(participantSet).slice(0, 5),
                sentiment: 'neutral',
                actionItems: [],
                timeline: `${emails.length} messages over the conversation`
            }
        });
    }

    try {
        const threadText = emails.map((e, i) =>
            `[${i + 1}] From: ${e.sender}\nDate: ${e.received}\nSubject: ${e.subject}\n${e.preview || e.body || ''}`
        ).join('\n\n---\n\n');

        const response = await callClaudeAPI(settings.claudeApiKey, [
            {
                role: 'user',
                content: `Summarize this email thread concisely. Return JSON with:
- headline: One sentence summary (max 15 words)
- keyPoints: Array of 3-5 bullet points
- participants: Array of participant names
- sentiment: "positive", "negative", "neutral", or "urgent"
- actionItems: Array of action items mentioned
- timeline: Brief timeline description

Thread:
${threadText}`
            }
        ], 'Return only valid JSON, no markdown.');

        const content = response.content[0].text;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const summary = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

        res.json({ success: true, summary });

    } catch (error) {
        console.error('Thread summarize error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ADVANCED AI: SMART COMPOSE ============

app.post('/api/ai/smart-compose', async (req, res) => {
    const { partialText, context, emailSubject, emailSender } = req.body;

    if (!partialText || partialText.length < 5) {
        return res.json({ success: true, suggestions: [] });
    }

    const settings = loadSettings();
    if (!settings.claudeApiKey) {
        // Smart local completions based on common patterns
        const completions = getLocalCompletions(partialText);
        return res.json({ success: true, suggestions: completions });
    }

    try {
        const response = await callClaudeAPI(settings.claudeApiKey, [
            {
                role: 'user',
                content: `Complete this email reply naturally. Context: replying to "${emailSubject}" from ${emailSender}.

Partial text: "${partialText}"

Provide 3 different completions. Return JSON array with objects containing:
- completion: The rest of the sentence/paragraph (not the original text)
- style: "formal", "casual", or "concise"`
            }
        ], 'Return only valid JSON array, no markdown. Keep completions under 50 words each.');

        const content = response.content[0].text;
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        const suggestions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

        res.json({ success: true, suggestions });

    } catch (error) {
        console.error('Smart compose error:', error);
        res.json({ success: true, suggestions: getLocalCompletions(partialText) });
    }
});

function getLocalCompletions(text) {
    const lower = text.toLowerCase().trim();
    const completions = [];

    // Common email starters
    if (lower.startsWith('thank')) {
        completions.push(
            { completion: ' you for getting back to me. I appreciate your quick response.', style: 'formal' },
            { completion: ' you! That makes sense.', style: 'casual' },
            { completion: ' you for the update.', style: 'concise' }
        );
    } else if (lower.startsWith('i wanted to')) {
        completions.push(
            { completion: ' follow up on our previous conversation.', style: 'formal' },
            { completion: ' check in and see how things are going.', style: 'casual' },
            { completion: ' confirm the details we discussed.', style: 'concise' }
        );
    } else if (lower.startsWith('just')) {
        completions.push(
            { completion: ' wanted to circle back on this.', style: 'formal' },
            { completion: ' checking in!', style: 'casual' },
            { completion: ' following up.', style: 'concise' }
        );
    } else if (lower.startsWith('let me')) {
        completions.push(
            { completion: ' know if you have any questions.', style: 'formal' },
            { completion: ' know what you think!', style: 'casual' },
            { completion: ' know.', style: 'concise' }
        );
    } else if (lower.startsWith('i\'ll')) {
        completions.push(
            { completion: ' get back to you by end of day.', style: 'formal' },
            { completion: ' send that over shortly.', style: 'casual' },
            { completion: ' follow up soon.', style: 'concise' }
        );
    } else if (lower.startsWith('sounds')) {
        completions.push(
            { completion: ' good. I\'ll proceed with the plan we discussed.', style: 'formal' },
            { completion: ' great! Let\'s do it.', style: 'casual' },
            { completion: ' good.', style: 'concise' }
        );
    } else if (lower.startsWith('please')) {
        completions.push(
            { completion: ' let me know if you need any additional information.', style: 'formal' },
            { completion: ' feel free to reach out with questions.', style: 'casual' },
            { completion: ' advise.', style: 'concise' }
        );
    } else if (lower.includes('attach')) {
        completions.push(
            { completion: 'ed is the document you requested.', style: 'formal' },
            { completion: 'ed! Let me know if you need anything else.', style: 'casual' },
            { completion: 'ed for your review.', style: 'concise' }
        );
    } else {
        // Generic completions
        completions.push(
            { completion: ' Please let me know your thoughts.', style: 'formal' },
            { completion: ' What do you think?', style: 'casual' },
            { completion: '', style: 'concise' }
        );
    }

    return completions;
}

// ============ ADVANCED AI: SENTIMENT ANALYSIS ============

app.post('/api/ai/analyze-sentiment', async (req, res) => {
    const { emails } = req.body;

    if (!emails || emails.length === 0) {
        return res.status(400).json({ success: false, error: 'No emails provided' });
    }

    const settings = loadSettings();

    // Analyze sentiment locally using keyword matching
    const analyzed = emails.map(email => {
        const text = `${email.subject || ''} ${email.preview || email.body || ''}`.toLowerCase();

        let sentiment = 'neutral';
        let confidence = 0.7;
        let indicators = [];

        // Urgent indicators
        const urgentWords = ['urgent', 'asap', 'immediately', 'critical', 'deadline', 'overdue', 'final notice', 'action required'];
        const urgentCount = urgentWords.filter(w => text.includes(w)).length;

        // Positive indicators
        const positiveWords = ['thank', 'great', 'excellent', 'happy', 'pleased', 'appreciate', 'congratulations', 'wonderful', 'good news'];
        const positiveCount = positiveWords.filter(w => text.includes(w)).length;

        // Negative indicators
        const negativeWords = ['sorry', 'unfortunately', 'issue', 'problem', 'failed', 'error', 'complaint', 'disappointed', 'concerned', 'urgent'];
        const negativeCount = negativeWords.filter(w => text.includes(w)).length;

        // Formal indicators
        const formalWords = ['dear', 'sincerely', 'regards', 'pursuant', 'hereby', 'attached please find'];
        const formalCount = formalWords.filter(w => text.includes(w)).length;

        if (urgentCount >= 2 || text.includes('!!!') || text.includes('URGENT')) {
            sentiment = 'urgent';
            confidence = 0.9;
            indicators = urgentWords.filter(w => text.includes(w));
        } else if (positiveCount > negativeCount && positiveCount >= 2) {
            sentiment = 'positive';
            confidence = 0.6 + (positiveCount * 0.1);
            indicators = positiveWords.filter(w => text.includes(w));
        } else if (negativeCount > positiveCount && negativeCount >= 2) {
            sentiment = 'negative';
            confidence = 0.6 + (negativeCount * 0.1);
            indicators = negativeWords.filter(w => text.includes(w));
        }

        // Tone detection
        let tone = 'standard';
        if (formalCount >= 2) tone = 'formal';
        else if (text.includes('!') && !text.includes('urgent')) tone = 'enthusiastic';
        else if (text.match(/\?{2,}/)) tone = 'questioning';

        return {
            id: email.id,
            subject: email.subject,
            sender: email.sender,
            sentiment,
            confidence: Math.min(confidence, 0.95),
            tone,
            indicators: indicators.slice(0, 3),
            emoji: getSentimentEmoji(sentiment)
        };
    });

    // Calculate overall stats
    const stats = {
        total: analyzed.length,
        urgent: analyzed.filter(e => e.sentiment === 'urgent').length,
        positive: analyzed.filter(e => e.sentiment === 'positive').length,
        negative: analyzed.filter(e => e.sentiment === 'negative').length,
        neutral: analyzed.filter(e => e.sentiment === 'neutral').length
    };

    res.json({
        success: true,
        emails: analyzed,
        stats,
        insight: generateSentimentInsight(stats)
    });
});

function getSentimentEmoji(sentiment) {
    switch (sentiment) {
        case 'urgent': return '🚨';
        case 'positive': return '😊';
        case 'negative': return '😟';
        default: return '📧';
    }
}

function generateSentimentInsight(stats) {
    if (stats.urgent > 0) {
        return `⚠️ ${stats.urgent} urgent email${stats.urgent > 1 ? 's' : ''} need${stats.urgent === 1 ? 's' : ''} immediate attention`;
    }
    if (stats.negative > stats.positive) {
        return `📉 More negative than positive emails today. Consider addressing concerns first.`;
    }
    if (stats.positive > stats.negative) {
        return `📈 Inbox is looking positive! ${stats.positive} email${stats.positive > 1 ? 's' : ''} with good news.`;
    }
    return `📊 Inbox is mostly neutral. Business as usual.`;
}

// ============ ADVANCED AI: AUTO-CATEGORIZATION ============

const CATEGORY_FILE = path.join(__dirname, 'email-categories.json');

function loadCategories() {
    try {
        if (fs.existsSync(CATEGORY_FILE)) {
            return JSON.parse(fs.readFileSync(CATEGORY_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        categories: [
            { id: 1, name: 'Work', color: '#3b82f6', keywords: ['meeting', 'project', 'deadline', 'report', 'team'], folder: 'Work' },
            { id: 2, name: 'Finance', color: '#10b981', keywords: ['payment', 'invoice', 'bank', 'transaction', 'credit'], folder: 'Finance' },
            { id: 3, name: 'Shopping', color: '#f59e0b', keywords: ['order', 'shipping', 'delivery', 'purchase', 'receipt'], folder: 'Shopping' },
            { id: 4, name: 'Social', color: '#ec4899', keywords: ['invitation', 'party', 'birthday', 'event', 'rsvp'], folder: 'Social' },
            { id: 5, name: 'Development', color: '#8b5cf6', keywords: ['github', 'deploy', 'build', 'error', 'commit', 'pr', 'merge'], folder: 'Dev' },
            { id: 6, name: 'Newsletters', color: '#6b7280', keywords: ['unsubscribe', 'newsletter', 'digest', 'weekly', 'update'], folder: 'Newsletters' }
        ],
        learned: {}
    };
}

function saveCategories(data) {
    fs.writeFileSync(CATEGORY_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/ai/categories', (req, res) => {
    const data = loadCategories();
    res.json({ success: true, categories: data.categories });
});

app.post('/api/ai/categories', (req, res) => {
    const { name, color, keywords, folder } = req.body;

    if (!name) {
        return res.status(400).json({ success: false, error: 'Name required' });
    }

    const data = loadCategories();
    const newCategory = {
        id: Date.now(),
        name,
        color: color || '#6b7280',
        keywords: keywords || [],
        folder: folder || name
    };

    data.categories.push(newCategory);
    saveCategories(data);

    res.json({ success: true, category: newCategory });
});

app.post('/api/ai/categorize', async (req, res) => {
    const { emails } = req.body;

    if (!emails || emails.length === 0) {
        return res.status(400).json({ success: false, error: 'No emails provided' });
    }

    const data = loadCategories();
    const settings = loadSettings();

    const categorized = emails.map(email => {
        const text = `${email.subject || ''} ${email.sender || ''} ${email.preview || ''}`.toLowerCase();

        // Check learned patterns first
        const senderDomain = (email.sender || '').split('@')[1];
        if (senderDomain && data.learned[senderDomain]) {
            const learnedCat = data.categories.find(c => c.id === data.learned[senderDomain]);
            if (learnedCat) {
                return {
                    ...email,
                    category: learnedCat,
                    confidence: 0.95,
                    reason: 'Learned from previous actions'
                };
            }
        }

        // Score each category
        let bestMatch = null;
        let bestScore = 0;

        for (const category of data.categories) {
            let score = 0;
            const matchedKeywords = [];

            for (const keyword of category.keywords) {
                if (text.includes(keyword.toLowerCase())) {
                    score += 1;
                    matchedKeywords.push(keyword);
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = { category, matchedKeywords };
            }
        }

        if (bestMatch && bestScore >= 1) {
            return {
                ...email,
                category: bestMatch.category,
                confidence: Math.min(0.5 + (bestScore * 0.15), 0.9),
                reason: `Matched: ${bestMatch.matchedKeywords.join(', ')}`
            };
        }

        return {
            ...email,
            category: null,
            confidence: 0,
            reason: 'No category match'
        };
    });

    // Calculate stats
    const stats = {};
    for (const cat of data.categories) {
        stats[cat.name] = categorized.filter(e => e.category?.id === cat.id).length;
    }
    stats['Uncategorized'] = categorized.filter(e => !e.category).length;

    res.json({
        success: true,
        emails: categorized,
        stats,
        suggestions: generateCategorySuggestions(categorized, data.categories)
    });
});

app.post('/api/ai/learn-category', (req, res) => {
    const { senderDomain, categoryId } = req.body;

    if (!senderDomain || !categoryId) {
        return res.status(400).json({ success: false, error: 'Sender domain and category required' });
    }

    const data = loadCategories();
    data.learned[senderDomain] = categoryId;
    saveCategories(data);

    res.json({ success: true, message: `Learned: emails from ${senderDomain} → category ${categoryId}` });
});

app.post('/api/ai/apply-category', (req, res) => {
    const { emailId, categoryId, folderName } = req.body;

    try {
        // Move email to folder using AppleScript
        const script = `
            tell application "Mail"
                set targetMailbox to mailbox "${folderName}" of account 1
                set theMessages to (messages of inbox whose id is ${emailId})
                repeat with theMessage in theMessages
                    move theMessage to targetMailbox
                end repeat
            end tell
        `;

        // For now, just log the action (AppleScript mail moving can be tricky)
        console.log(`Would move email ${emailId} to folder ${folderName}`);

        res.json({ success: true, message: `Email would be moved to ${folderName}` });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

function generateCategorySuggestions(emails, categories) {
    const suggestions = [];
    const uncategorized = emails.filter(e => !e.category);

    // Find common patterns in uncategorized emails
    const senderPatterns = {};
    for (const email of uncategorized) {
        const domain = (email.sender || '').split('@')[1];
        if (domain) {
            senderPatterns[domain] = (senderPatterns[domain] || 0) + 1;
        }
    }

    // Suggest new categories for frequent senders
    for (const [domain, count] of Object.entries(senderPatterns)) {
        if (count >= 3) {
            suggestions.push({
                type: 'new_category',
                suggestion: `Create category for ${domain} (${count} emails)`
            });
        }
    }

    // Suggest keywords to add
    const allWords = uncategorized
        .flatMap(e => (e.subject || '').toLowerCase().split(/\s+/))
        .filter(w => w.length > 4);

    const wordFreq = {};
    for (const word of allWords) {
        wordFreq[word] = (wordFreq[word] || 0) + 1;
    }

    const topWords = Object.entries(wordFreq)
        .filter(([_, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

    for (const [word, count] of topWords) {
        suggestions.push({
            type: 'add_keyword',
            suggestion: `Add keyword "${word}" to a category (appears ${count} times)`
        });
    }

    return suggestions;
}

// ============ AUTOMATION: FOLLOW-UP REMINDERS ============

const FOLLOWUPS_FILE = path.join(__dirname, 'followup-reminders.json');

function loadFollowups() {
    try {
        if (fs.existsSync(FOLLOWUPS_FILE)) {
            return JSON.parse(fs.readFileSync(FOLLOWUPS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { reminders: [] };
}

function saveFollowups(data) {
    fs.writeFileSync(FOLLOWUPS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/followups', (req, res) => {
    const data = loadFollowups();
    const now = Date.now();

    // Mark overdue reminders
    const reminders = data.reminders.map(r => ({
        ...r,
        isOverdue: r.status === 'pending' && new Date(r.remindAt).getTime() < now,
        daysUntil: Math.ceil((new Date(r.remindAt).getTime() - now) / (1000 * 60 * 60 * 24))
    }));

    res.json({
        success: true,
        reminders,
        stats: {
            total: reminders.length,
            pending: reminders.filter(r => r.status === 'pending').length,
            overdue: reminders.filter(r => r.isOverdue).length
        }
    });
});

app.post('/api/followups', (req, res) => {
    const { emailId, emailSubject, emailSender, daysUntilRemind, note } = req.body;

    if (!emailId || !daysUntilRemind) {
        return res.status(400).json({ success: false, error: 'Email ID and days required' });
    }

    const data = loadFollowups();
    const reminder = {
        id: Date.now(),
        emailId,
        emailSubject: emailSubject || 'No subject',
        emailSender: emailSender || 'Unknown',
        note: note || '',
        createdAt: new Date().toISOString(),
        remindAt: new Date(Date.now() + daysUntilRemind * 24 * 60 * 60 * 1000).toISOString(),
        status: 'pending'
    };

    data.reminders.push(reminder);
    saveFollowups(data);

    res.json({ success: true, reminder });
});

app.put('/api/followups/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { status, note, remindAt } = req.body;

    const data = loadFollowups();
    const reminder = data.reminders.find(r => r.id === id);

    if (!reminder) {
        return res.status(404).json({ success: false, error: 'Reminder not found' });
    }

    if (status) reminder.status = status;
    if (note !== undefined) reminder.note = note;
    if (remindAt) reminder.remindAt = remindAt;

    saveFollowups(data);
    res.json({ success: true, reminder });
});

app.delete('/api/followups/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadFollowups();
    data.reminders = data.reminders.filter(r => r.id !== id);
    saveFollowups(data);
    res.json({ success: true });
});

app.get('/api/followups/check', (req, res) => {
    const data = loadFollowups();
    const now = Date.now();

    const due = data.reminders.filter(r =>
        r.status === 'pending' &&
        new Date(r.remindAt).getTime() <= now
    );

    res.json({
        success: true,
        dueReminders: due,
        count: due.length
    });
});

// ============ AUTOMATION: EMAIL SEQUENCES ============

const SEQUENCES_FILE = path.join(__dirname, 'email-sequences.json');

function loadSequences() {
    try {
        if (fs.existsSync(SEQUENCES_FILE)) {
            return JSON.parse(fs.readFileSync(SEQUENCES_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        templates: [
            {
                id: 1,
                name: 'Sales Follow-up',
                steps: [
                    { day: 0, subject: 'Nice to meet you!', body: 'Hi {{name}},\n\nIt was great connecting with you...' },
                    { day: 3, subject: 'Following up', body: 'Hi {{name}},\n\nJust wanted to follow up on our conversation...' },
                    { day: 7, subject: 'Any thoughts?', body: 'Hi {{name}},\n\nI wanted to check in one more time...' }
                ]
            },
            {
                id: 2,
                name: 'Job Application',
                steps: [
                    { day: 0, subject: 'Application for {{position}}', body: 'Dear Hiring Manager,\n\nI am writing to apply...' },
                    { day: 5, subject: 'Following up on my application', body: 'Dear Hiring Manager,\n\nI wanted to follow up...' },
                    { day: 10, subject: 'Still interested in {{position}}', body: 'Dear Hiring Manager,\n\nI remain very interested...' }
                ]
            },
            {
                id: 3,
                name: 'Invoice Reminder',
                steps: [
                    { day: 0, subject: 'Invoice #{{invoice}} - Due Soon', body: 'Hi {{name}},\n\nThis is a friendly reminder...' },
                    { day: 7, subject: 'Invoice #{{invoice}} - Past Due', body: 'Hi {{name}},\n\nYour invoice is now past due...' },
                    { day: 14, subject: 'Final Notice - Invoice #{{invoice}}', body: 'Hi {{name}},\n\nThis is a final reminder...' }
                ]
            }
        ],
        active: []
    };
}

function saveSequences(data) {
    fs.writeFileSync(SEQUENCES_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/sequences/templates', (req, res) => {
    const data = loadSequences();
    res.json({ success: true, templates: data.templates });
});

app.post('/api/sequences/templates', (req, res) => {
    const { name, steps } = req.body;

    if (!name || !steps || steps.length === 0) {
        return res.status(400).json({ success: false, error: 'Name and steps required' });
    }

    const data = loadSequences();
    const template = {
        id: Date.now(),
        name,
        steps
    };

    data.templates.push(template);
    saveSequences(data);

    res.json({ success: true, template });
});

app.get('/api/sequences/active', (req, res) => {
    const data = loadSequences();
    const now = Date.now();

    const active = data.active.map(seq => {
        const nextStep = seq.steps.find(s => s.status === 'pending');
        return {
            ...seq,
            nextStep: nextStep ? {
                ...nextStep,
                scheduledFor: new Date(new Date(seq.startedAt).getTime() + nextStep.day * 24 * 60 * 60 * 1000).toISOString()
            } : null,
            progress: `${seq.steps.filter(s => s.status === 'sent').length}/${seq.steps.length}`
        };
    });

    res.json({ success: true, sequences: active });
});

app.post('/api/sequences/start', (req, res) => {
    const { templateId, recipientEmail, recipientName, variables } = req.body;

    if (!templateId || !recipientEmail) {
        return res.status(400).json({ success: false, error: 'Template and recipient required' });
    }

    const data = loadSequences();
    const template = data.templates.find(t => t.id === templateId);

    if (!template) {
        return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const sequence = {
        id: Date.now(),
        templateId,
        templateName: template.name,
        recipientEmail,
        recipientName: recipientName || recipientEmail.split('@')[0],
        variables: variables || {},
        startedAt: new Date().toISOString(),
        status: 'active',
        steps: template.steps.map((step, i) => ({
            ...step,
            stepNumber: i + 1,
            status: 'pending'
        }))
    };

    data.active.push(sequence);
    saveSequences(data);

    res.json({ success: true, sequence });
});

app.post('/api/sequences/:id/send-next', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadSequences();
    const sequence = data.active.find(s => s.id === id);

    if (!sequence) {
        return res.status(404).json({ success: false, error: 'Sequence not found' });
    }

    const nextStep = sequence.steps.find(s => s.status === 'pending');
    if (!nextStep) {
        return res.json({ success: false, error: 'No pending steps' });
    }

    // Replace variables in subject and body
    let subject = nextStep.subject;
    let body = nextStep.body;

    const vars = { name: sequence.recipientName, ...sequence.variables };
    for (const [key, value] of Object.entries(vars)) {
        subject = subject.replace(new RegExp(`{{${key}}}`, 'g'), value);
        body = body.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }

    // Open email in Mail app
    const script = `
        tell application "Mail"
            set newMessage to make new outgoing message with properties {subject:"${subject.replace(/"/g, '\\"')}", content:"${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}
            tell newMessage
                make new to recipient with properties {address:"${sequence.recipientEmail}"}
            end tell
            activate
        end tell
    `;

    try {
        runAppleScript(script);
        nextStep.status = 'sent';
        nextStep.sentAt = new Date().toISOString();

        // Check if sequence is complete
        if (sequence.steps.every(s => s.status === 'sent')) {
            sequence.status = 'completed';
            sequence.completedAt = new Date().toISOString();
        }

        saveSequences(data);
        res.json({ success: true, step: nextStep });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/sequences/:id/pause', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadSequences();
    const sequence = data.active.find(s => s.id === id);

    if (!sequence) {
        return res.status(404).json({ success: false, error: 'Sequence not found' });
    }

    sequence.status = sequence.status === 'paused' ? 'active' : 'paused';
    saveSequences(data);

    res.json({ success: true, status: sequence.status });
});

app.delete('/api/sequences/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadSequences();
    data.active = data.active.filter(s => s.id !== id);
    saveSequences(data);
    res.json({ success: true });
});

// ============ AUTOMATION: SCHEDULED SENDING ============

const SCHEDULED_FILE = path.join(__dirname, 'scheduled-emails.json');

function loadScheduled() {
    try {
        if (fs.existsSync(SCHEDULED_FILE)) {
            return JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { emails: [] };
}

function saveScheduled(data) {
    fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/scheduled', (req, res) => {
    const data = loadScheduled();
    const now = Date.now();

    const emails = data.emails.map(e => ({
        ...e,
        isReady: e.status === 'scheduled' && new Date(e.sendAt).getTime() <= now,
        timeUntil: formatTimeUntil(new Date(e.sendAt).getTime() - now)
    }));

    res.json({
        success: true,
        emails,
        stats: {
            scheduled: emails.filter(e => e.status === 'scheduled').length,
            ready: emails.filter(e => e.isReady).length,
            sent: emails.filter(e => e.status === 'sent').length
        }
    });
});

function formatTimeUntil(ms) {
    if (ms <= 0) return 'Now';
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 24) {
        const days = Math.floor(hours / 24);
        return `${days}d ${hours % 24}h`;
    }
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

app.post('/api/scheduled', (req, res) => {
    const { to, subject, body, sendAt } = req.body;

    if (!to || !subject || !sendAt) {
        return res.status(400).json({ success: false, error: 'To, subject, and sendAt required' });
    }

    const data = loadScheduled();
    const email = {
        id: Date.now(),
        to,
        subject,
        body: body || '',
        sendAt,
        createdAt: new Date().toISOString(),
        status: 'scheduled'
    };

    data.emails.push(email);
    saveScheduled(data);

    res.json({ success: true, email });
});

app.post('/api/scheduled/:id/send-now', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadScheduled();
    const email = data.emails.find(e => e.id === id);

    if (!email) {
        return res.status(404).json({ success: false, error: 'Email not found' });
    }

    // Open email in Mail app
    const script = `
        tell application "Mail"
            set newMessage to make new outgoing message with properties {subject:"${email.subject.replace(/"/g, '\\"')}", content:"${email.body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}
            tell newMessage
                make new to recipient with properties {address:"${email.to}"}
            end tell
            activate
        end tell
    `;

    try {
        runAppleScript(script);
        email.status = 'sent';
        email.sentAt = new Date().toISOString();
        saveScheduled(data);
        res.json({ success: true, email });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/scheduled/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { to, subject, body, sendAt } = req.body;

    const data = loadScheduled();
    const email = data.emails.find(e => e.id === id);

    if (!email) {
        return res.status(404).json({ success: false, error: 'Email not found' });
    }

    if (to) email.to = to;
    if (subject) email.subject = subject;
    if (body !== undefined) email.body = body;
    if (sendAt) email.sendAt = sendAt;

    saveScheduled(data);
    res.json({ success: true, email });
});

app.delete('/api/scheduled/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadScheduled();
    data.emails = data.emails.filter(e => e.id !== id);
    saveScheduled(data);
    res.json({ success: true });
});

app.get('/api/scheduled/check', (req, res) => {
    const data = loadScheduled();
    const now = Date.now();

    const ready = data.emails.filter(e =>
        e.status === 'scheduled' &&
        new Date(e.sendAt).getTime() <= now
    );

    res.json({
        success: true,
        readyToSend: ready,
        count: ready.length
    });
});

// ============ AUTOMATION: BATCH OPERATIONS ============

app.post('/api/batch/preview', (req, res) => {
    const { filter } = req.body;

    if (!filter) {
        return res.status(400).json({ success: false, error: 'Filter required' });
    }

    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        let query = `
            SELECT
                m.ROWID as id,
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                s.subject,
                a.address as sender,
                m.read,
                m.flagged
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.deleted = 0
        `;

        const params = [];

        // Apply filters
        if (filter.sender) {
            query += ` AND a.address LIKE ?`;
            params.push(`%${filter.sender}%`);
        }
        if (filter.subject) {
            query += ` AND s.subject LIKE ?`;
            params.push(`%${filter.subject}%`);
        }
        if (filter.olderThanDays) {
            query += ` AND m.date_received < strftime('%s', 'now', '-' || ? || ' days')`;
            params.push(filter.olderThanDays);
        }
        if (filter.unreadOnly) {
            query += ` AND m.read = 0`;
        }
        if (filter.readOnly) {
            query += ` AND m.read = 1`;
        }

        query += ` ORDER BY m.date_received DESC LIMIT 100`;

        const emails = db.prepare(query).all(...params);
        db.close();

        res.json({
            success: true,
            emails,
            count: emails.length,
            message: `Found ${emails.length} emails matching filter`
        });

    } catch (error) {
        console.error('Batch preview error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/batch/execute', async (req, res) => {
    const { emailIds, action } = req.body;

    if (!emailIds || emailIds.length === 0 || !action) {
        return res.status(400).json({ success: false, error: 'Email IDs and action required' });
    }

    const validActions = ['archive', 'delete', 'markRead', 'markUnread', 'flag', 'unflag'];
    if (!validActions.includes(action)) {
        return res.status(400).json({ success: false, error: `Invalid action. Valid: ${validActions.join(', ')}` });
    }

    const results = { success: 0, failed: 0, errors: [] };

    for (const id of emailIds) {
        try {
            let script = '';

            switch (action) {
                case 'archive':
                    // Move to Archive mailbox
                    script = `
                        tell application "Mail"
                            set theMessages to (messages of inbox whose id is ${id})
                            repeat with theMessage in theMessages
                                set read status of theMessage to true
                                delete theMessage
                            end repeat
                        end tell
                    `;
                    break;

                case 'delete':
                    script = `
                        tell application "Mail"
                            set theMessages to (messages of inbox whose id is ${id})
                            repeat with theMessage in theMessages
                                delete theMessage
                            end repeat
                        end tell
                    `;
                    break;

                case 'markRead':
                    script = `
                        tell application "Mail"
                            set theMessages to (messages of inbox whose id is ${id})
                            repeat with theMessage in theMessages
                                set read status of theMessage to true
                            end repeat
                        end tell
                    `;
                    break;

                case 'markUnread':
                    script = `
                        tell application "Mail"
                            set theMessages to (messages of inbox whose id is ${id})
                            repeat with theMessage in theMessages
                                set read status of theMessage to false
                            end repeat
                        end tell
                    `;
                    break;

                case 'flag':
                    script = `
                        tell application "Mail"
                            set theMessages to (messages of inbox whose id is ${id})
                            repeat with theMessage in theMessages
                                set flagged status of theMessage to true
                            end repeat
                        end tell
                    `;
                    break;

                case 'unflag':
                    script = `
                        tell application "Mail"
                            set theMessages to (messages of inbox whose id is ${id})
                            repeat with theMessage in theMessages
                                set flagged status of theMessage to false
                            end repeat
                        end tell
                    `;
                    break;
            }

            runAppleScript(script);
            results.success++;

        } catch (error) {
            results.failed++;
            results.errors.push({ id, error: error.message });
        }
    }

    // Log the batch action
    const actionsData = loadActions();
    actionsData.actions.push({
        type: `batch_${action}`,
        count: results.success,
        timestamp: new Date().toISOString()
    });
    saveActions(actionsData);

    res.json({
        success: true,
        results,
        message: `${action}: ${results.success} succeeded, ${results.failed} failed`
    });
});

// Saved batch filters
const BATCH_FILTERS_FILE = path.join(__dirname, 'batch-filters.json');

function loadBatchFilters() {
    try {
        if (fs.existsSync(BATCH_FILTERS_FILE)) {
            return JSON.parse(fs.readFileSync(BATCH_FILTERS_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        filters: [
            { id: 1, name: 'Old Newsletters', filter: { sender: 'newsletter', olderThanDays: 30 } },
            { id: 2, name: 'Read Promotions', filter: { sender: 'promo', readOnly: true } },
            { id: 3, name: 'Old GitHub Notifications', filter: { sender: 'github.com', olderThanDays: 14, readOnly: true } }
        ]
    };
}

function saveBatchFilters(data) {
    fs.writeFileSync(BATCH_FILTERS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/batch/filters', (req, res) => {
    const data = loadBatchFilters();
    res.json({ success: true, filters: data.filters });
});

app.post('/api/batch/filters', (req, res) => {
    const { name, filter } = req.body;

    if (!name || !filter) {
        return res.status(400).json({ success: false, error: 'Name and filter required' });
    }

    const data = loadBatchFilters();
    const newFilter = {
        id: Date.now(),
        name,
        filter
    };

    data.filters.push(newFilter);
    saveBatchFilters(data);

    res.json({ success: true, filter: newFilter });
});

app.delete('/api/batch/filters/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadBatchFilters();
    data.filters = data.filters.filter(f => f.id !== id);
    saveBatchFilters(data);
    res.json({ success: true });
});

// ============ UX: FULL-TEXT SEARCH ============

app.get('/api/search', (req, res) => {
    const { q, sender, subject, hasAttachment, unreadOnly, limit = 50 } = req.query;

    if (!q && !sender && !subject) {
        return res.status(400).json({ success: false, error: 'Search query required' });
    }

    try {
        const db = new Database(MAIL_DB_PATH, { readonly: true });

        let query = `
            SELECT
                m.ROWID as id,
                datetime(m.date_received, 'unixepoch', 'localtime') as received,
                s.subject,
                a.address as sender,
                m.read,
                m.flagged,
                m.date_received as timestamp
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            WHERE m.deleted = 0
        `;

        const params = [];

        // Full-text search on subject
        if (q) {
            query += ` AND (s.subject LIKE ? OR a.address LIKE ?)`;
            params.push(`%${q}%`, `%${q}%`);
        }

        if (sender) {
            query += ` AND a.address LIKE ?`;
            params.push(`%${sender}%`);
        }

        if (subject) {
            query += ` AND s.subject LIKE ?`;
            params.push(`%${subject}%`);
        }

        if (unreadOnly === 'true') {
            query += ` AND m.read = 0`;
        }

        query += ` ORDER BY m.date_received DESC LIMIT ?`;
        params.push(parseInt(limit));

        const results = db.prepare(query).all(...params);
        db.close();

        // Highlight matches in results
        const highlighted = results.map(r => ({
            ...r,
            subjectHighlight: q ? highlightMatch(r.subject, q) : r.subject,
            senderHighlight: q ? highlightMatch(r.sender, q) : r.sender
        }));

        res.json({
            success: true,
            results: highlighted,
            count: results.length,
            query: { q, sender, subject }
        });

    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function highlightMatch(text, query) {
    if (!text || !query) return text;
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

// ============ UX: SAVED SEARCHES ============

const SAVED_SEARCHES_FILE = path.join(__dirname, 'saved-searches.json');

function loadSavedSearches() {
    try {
        if (fs.existsSync(SAVED_SEARCHES_FILE)) {
            return JSON.parse(fs.readFileSync(SAVED_SEARCHES_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        searches: [
            { id: 1, name: 'Unread from VIPs', query: { unreadOnly: 'true' }, icon: '⭐' },
            { id: 2, name: 'GitHub Notifications', query: { sender: 'github.com' }, icon: '🐙' },
            { id: 3, name: 'Financial Emails', query: { q: 'payment OR invoice OR bank' }, icon: '💰' },
            { id: 4, name: 'This Week', query: { daysBack: 7 }, icon: '📅' }
        ]
    };
}

function saveSavedSearches(data) {
    fs.writeFileSync(SAVED_SEARCHES_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/searches', (req, res) => {
    const data = loadSavedSearches();
    res.json({ success: true, searches: data.searches });
});

app.post('/api/searches', (req, res) => {
    const { name, query, icon } = req.body;

    if (!name || !query) {
        return res.status(400).json({ success: false, error: 'Name and query required' });
    }

    const data = loadSavedSearches();
    const search = {
        id: Date.now(),
        name,
        query,
        icon: icon || '🔍'
    };

    data.searches.push(search);
    saveSavedSearches(data);

    res.json({ success: true, search });
});

app.delete('/api/searches/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadSavedSearches();
    data.searches = data.searches.filter(s => s.id !== id);
    saveSavedSearches(data);
    res.json({ success: true });
});

// ============ UX: DASHBOARD LAYOUT ============

const LAYOUT_FILE = path.join(__dirname, 'dashboard-layout.json');

function loadLayout() {
    try {
        if (fs.existsSync(LAYOUT_FILE)) {
            return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        widgets: [
            { id: 'priority-inbox', order: 1, visible: true, collapsed: false },
            { id: 'calendar-section', order: 2, visible: true, collapsed: false },
            { id: 'files-section', order: 3, visible: true, collapsed: false },
            { id: 'unsubscribe-section', order: 4, visible: true, collapsed: false },
            { id: 'goals-section', order: 5, visible: true, collapsed: false },
            { id: 'rules-section', order: 6, visible: true, collapsed: false },
            { id: 'timeblocking-section', order: 7, visible: true, collapsed: false },
            { id: 'report-section', order: 8, visible: true, collapsed: false },
            { id: 'integrations-section', order: 9, visible: true, collapsed: false },
            { id: 'ai-features-section', order: 10, visible: true, collapsed: false },
            { id: 'automation-section', order: 11, visible: true, collapsed: false }
        ],
        sidebarWidgets: [
            { id: 'briefing', order: 1, visible: true },
            { id: 'weather', order: 2, visible: true },
            { id: 'productivity', order: 3, visible: true },
            { id: 'quick-actions', order: 4, visible: true }
        ]
    };
}

function saveLayout(data) {
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/layout', (req, res) => {
    const layout = loadLayout();
    res.json({ success: true, layout });
});

app.put('/api/layout', (req, res) => {
    const { widgets, sidebarWidgets } = req.body;

    const layout = loadLayout();
    if (widgets) layout.widgets = widgets;
    if (sidebarWidgets) layout.sidebarWidgets = sidebarWidgets;

    saveLayout(layout);
    res.json({ success: true, layout });
});

app.put('/api/layout/widget/:id', (req, res) => {
    const { id } = req.params;
    const { visible, collapsed, order } = req.body;

    const layout = loadLayout();
    const widget = layout.widgets.find(w => w.id === id);

    if (!widget) {
        return res.status(404).json({ success: false, error: 'Widget not found' });
    }

    if (visible !== undefined) widget.visible = visible;
    if (collapsed !== undefined) widget.collapsed = collapsed;
    if (order !== undefined) widget.order = order;

    saveLayout(layout);
    res.json({ success: true, widget });
});

// ============ UX: EMAIL TEMPLATES (ENHANCED) ============

const TEMPLATES_FILE = path.join(__dirname, 'reply-templates.json');

function loadTemplatesData() {
    try {
        if (fs.existsSync(TEMPLATES_FILE)) {
            return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        templates: [
            {
                id: 1,
                name: 'Quick Thanks',
                body: 'Thank you for your email. I appreciate you reaching out.',
                category: 'general',
                shortcut: 'ty',
                usageCount: 0
            },
            {
                id: 2,
                name: 'Will Review',
                body: 'Thanks for sending this over. I\'ll review it and get back to you shortly.',
                category: 'general',
                shortcut: 'wr',
                usageCount: 0
            },
            {
                id: 3,
                name: 'Schedule Meeting',
                body: 'I\'d love to discuss this further. Would you be available for a quick call this week? Here are some times that work for me:\n\n- \n- \n\nLet me know what works best for you.',
                category: 'meeting',
                shortcut: 'sm',
                usageCount: 0
            },
            {
                id: 4,
                name: 'Follow Up',
                body: 'I wanted to follow up on my previous email. Have you had a chance to review it?\n\nPlease let me know if you have any questions.',
                category: 'followup',
                shortcut: 'fu',
                usageCount: 0
            },
            {
                id: 5,
                name: 'Out of Office',
                body: 'Thank you for your email. I\'m currently out of the office with limited access to email. I\'ll respond to your message when I return.\n\nFor urgent matters, please contact [alternate contact].',
                category: 'general',
                shortcut: 'ooo',
                usageCount: 0
            },
            {
                id: 6,
                name: 'Decline Politely',
                body: 'Thank you for thinking of me. Unfortunately, I\'m not able to take this on at the moment due to other commitments.\n\nI appreciate your understanding and wish you the best with this.',
                category: 'general',
                shortcut: 'dp',
                usageCount: 0
            }
        ],
        categories: ['general', 'meeting', 'followup', 'sales', 'support']
    };
}

function saveTemplatesData(data) {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/templates', (req, res) => {
    const data = loadTemplatesData();
    res.json({ success: true, templates: data.templates, categories: data.categories });
});

app.post('/api/templates', (req, res) => {
    const { name, body, category, shortcut } = req.body;

    if (!name || !body) {
        return res.status(400).json({ success: false, error: 'Name and body required' });
    }

    const data = loadTemplatesData();

    // Check for duplicate shortcut
    if (shortcut && data.templates.some(t => t.shortcut === shortcut)) {
        return res.status(400).json({ success: false, error: 'Shortcut already in use' });
    }

    const template = {
        id: Date.now(),
        name,
        body,
        category: category || 'general',
        shortcut: shortcut || '',
        usageCount: 0,
        createdAt: new Date().toISOString()
    };

    data.templates.push(template);
    saveTemplatesData(data);

    res.json({ success: true, template });
});

app.put('/api/templates/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { name, body, category, shortcut } = req.body;

    const data = loadTemplatesData();
    const template = data.templates.find(t => t.id === id);

    if (!template) {
        return res.status(404).json({ success: false, error: 'Template not found' });
    }

    if (name) template.name = name;
    if (body) template.body = body;
    if (category) template.category = category;
    if (shortcut !== undefined) template.shortcut = shortcut;

    saveTemplatesData(data);
    res.json({ success: true, template });
});

app.delete('/api/templates/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadTemplatesData();
    data.templates = data.templates.filter(t => t.id !== id);
    saveTemplatesData(data);
    res.json({ success: true });
});

app.post('/api/templates/:id/use', (req, res) => {
    const id = parseInt(req.params.id);
    const data = loadTemplatesData();
    const template = data.templates.find(t => t.id === id);

    if (!template) {
        return res.status(404).json({ success: false, error: 'Template not found' });
    }

    template.usageCount++;
    template.lastUsed = new Date().toISOString();
    saveTemplatesData(data);

    res.json({ success: true, template });
});

app.get('/api/templates/shortcut/:shortcut', (req, res) => {
    const { shortcut } = req.params;
    const data = loadTemplatesData();
    const template = data.templates.find(t => t.shortcut === shortcut);

    if (!template) {
        return res.status(404).json({ success: false, error: 'Shortcut not found' });
    }

    res.json({ success: true, template });
});

// ============ START SERVER ============

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║     FELIX — Your Chief of Staff                       ║
║     Dashboard running at http://localhost:${PORT}       ║
║                                                       ║
║     UX: Search, Saved Searches, Draggable Layout,     ║
║     Email Templates                                   ║
║     Press Ctrl+C to stop                              ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);
});
