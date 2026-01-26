// server.js - Paperwork Tracker Backend
// Logic: One active return per customer. Scan transfers if active exists, creates new if not.
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./paperwork.db', (err) => {
    if (err) console.error('DB error:', err);
    else { console.log('Connected to SQLite'); initDatabase(); }
});

function initDatabase() {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS paperwork (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        customer_no TEXT NOT NULL,
        order_ids TEXT,
        current_holder TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        completed_by TEXT,
        completed_at DATETIME,
        last_scan DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS scan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        paperwork_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        action TEXT DEFAULT 'received',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (paperwork_id) REFERENCES paperwork(id)
    )`);

    // Migration for existing DBs
    db.run(`ALTER TABLE paperwork ADD COLUMN status TEXT DEFAULT 'active'`, () => {});
    db.run(`ALTER TABLE paperwork ADD COLUMN completed_by TEXT`, () => {});
    db.run(`ALTER TABLE paperwork ADD COLUMN completed_at DATETIME`, () => {});

    console.log('Database initialized');
}

// Get all users
app.get('/api/users', (req, res) => {
    db.all('SELECT name FROM users ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(r => r.name));
    });
});

// Add user
app.post('/api/users', (req, res) => {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    db.run('INSERT OR IGNORE INTO users (name) VALUES (?)', [name.trim()], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ name: name.trim() });
    });
});

// Get all paperwork with history
app.get('/api/paperwork', (req, res) => {
    const { status } = req.query;
    let query = 'SELECT * FROM paperwork';
    let params = [];
    
    if (status) {
        query += ' WHERE status = ?';
        params.push(status);
    }
    query += ' ORDER BY last_scan DESC';

    db.all(query, params, (err, paperworkRows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (paperworkRows.length === 0) return res.json([]);

        db.all('SELECT * FROM scan_history ORDER BY timestamp ASC', [], (err, historyRows) => {
            if (err) return res.status(500).json({ error: err.message });

            const result = paperworkRows.map(row => ({
                id: row.id.toString(),
                company: row.company,
                customer_no: row.customer_no,
                order_ids: row.order_ids ? JSON.parse(row.order_ids) : [],
                current_holder: row.current_holder,
                status: row.status || 'active',
                completed_by: row.completed_by,
                completed_at: row.completed_at,
                last_scan: row.last_scan,
                created: row.created_at,
                history: historyRows
                    .filter(h => h.paperwork_id === row.id)
                    .map(h => ({ user: h.user_name, action: h.action, timestamp: h.timestamp }))
            }));

            res.json(result);
        });
    });
});

// SCAN: If active return exists for customer → transfer. If not → create new.
app.post('/api/scan', (req, res) => {
    const { company, customer_no, order_ids, user } = req.body;
    if (!company || !customer_no || !user) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const timestamp = new Date().toISOString();

    // Check for existing ACTIVE return for this customer
    db.get(
        'SELECT * FROM paperwork WHERE company = ? AND customer_no = ? AND status = ?',
        [company, customer_no, 'active'],
        (err, existing) => {
            if (err) return res.status(500).json({ error: err.message });

            if (existing) {
                // ACTIVE return exists → Transfer to new holder
                db.run(
                    'UPDATE paperwork SET current_holder = ?, last_scan = ? WHERE id = ?',
                    [user, timestamp, existing.id],
                    (err) => {
                        if (err) return res.status(500).json({ error: err.message });

                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, action, timestamp) VALUES (?, ?, ?, ?)',
                            [existing.id, user, 'received', timestamp],
                            (err) => {
                                if (err) return res.status(500).json({ error: err.message });
                                res.json({
                                    success: true,
                                    action: 'transferred',
                                    paperworkId: existing.id,
                                    message: `Transferred to ${user}`,
                                    company, customer_no
                                });
                            }
                        );
                    }
                );
            } else {
                // No active return → Create new
                db.run(
                    'INSERT INTO paperwork (company, customer_no, order_ids, current_holder, status, last_scan) VALUES (?, ?, ?, ?, ?, ?)',
                    [company, customer_no, JSON.stringify(order_ids || []), user, 'active', timestamp],
                    function(err) {
                        if (err) return res.status(500).json({ error: err.message });

                        const newId = this.lastID;
                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, action, timestamp) VALUES (?, ?, ?, ?)',
                            [newId, user, 'created', timestamp],
                            (err) => {
                                if (err) return res.status(500).json({ error: err.message });
                                res.json({
                                    success: true,
                                    action: 'created',
                                    paperworkId: newId,
                                    message: 'New return created',
                                    company, customer_no, order_ids
                                });
                            }
                        );
                    }
                );
            }
        }
    );
});

// Complete paperwork
app.post('/api/paperwork/:id/complete', (req, res) => {
    const { id } = req.params;
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'User required' });

    const timestamp = new Date().toISOString();

    db.get('SELECT * FROM paperwork WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        if (row.status === 'completed') return res.status(400).json({ error: 'Already completed' });

        db.run(
            'UPDATE paperwork SET status = ?, completed_by = ?, completed_at = ?, last_scan = ? WHERE id = ?',
            ['completed', user, timestamp, timestamp, id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });

                db.run(
                    'INSERT INTO scan_history (paperwork_id, user_name, action, timestamp) VALUES (?, ?, ?, ?)',
                    [id, user, 'completed', timestamp],
                    (err) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ success: true, completed_by: user, completed_at: timestamp });
                    }
                );
            }
        );
    });
});

// Reopen paperwork
app.post('/api/paperwork/:id/reopen', (req, res) => {
    const { id } = req.params;
    const { user } = req.body;
    if (!user) return res.status(400).json({ error: 'User required' });

    const timestamp = new Date().toISOString();

    // Check if customer already has an active return
    db.get('SELECT company, customer_no FROM paperwork WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });

        db.get(
            'SELECT id FROM paperwork WHERE company = ? AND customer_no = ? AND status = ? AND id != ?',
            [row.company, row.customer_no, 'active', id],
            (err, activeReturn) => {
                if (err) return res.status(500).json({ error: err.message });
                if (activeReturn) {
                    return res.status(400).json({ error: 'Customer already has an active return. Complete it first.' });
                }

                db.run(
                    'UPDATE paperwork SET status = ?, completed_by = NULL, completed_at = NULL, current_holder = ?, last_scan = ? WHERE id = ?',
                    ['active', user, timestamp, id],
                    (err) => {
                        if (err) return res.status(500).json({ error: err.message });

                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, action, timestamp) VALUES (?, ?, ?, ?)',
                            [id, user, 'reopened', timestamp],
                            (err) => {
                                if (err) return res.status(500).json({ error: err.message });
                                res.json({ success: true });
                            }
                        );
                    }
                );
            }
        );
    });
});

// Reset database
app.delete('/api/reset', (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM scan_history');
        db.run('DELETE FROM paperwork');
        db.run('DELETE FROM users');
    });
    res.json({ success: true, message: 'All data cleared' });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));

process.on('SIGINT', () => { db.close(); process.exit(0); });
