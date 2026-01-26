// server.js - Node.js Backend for Paperwork Tracker v4
// Added: customer_name, rep_name fields

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Database setup
const db = new sqlite3.Database('./paperwork.db');

// Initialize database tables
db.serialize(() => {
    // Users table
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Paperwork table - Added customer_name and rep_name
    db.run(`
        CREATE TABLE IF NOT EXISTS paperwork (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company TEXT NOT NULL,
            customer_no TEXT NOT NULL,
            customer_name TEXT,
            rep_name TEXT,
            order_ids TEXT,
            current_holder TEXT,
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            completed_by TEXT
        )
    `);

    // Scan history table
    db.run(`
        CREATE TABLE IF NOT EXISTS scan_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paperwork_id INTEGER,
            user_name TEXT NOT NULL,
            action TEXT DEFAULT 'transfer',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (paperwork_id) REFERENCES paperwork(id)
        )
    `);

    // Migration: Add new columns if they don't exist
    db.run(`ALTER TABLE paperwork ADD COLUMN customer_name TEXT`, (err) => {
        // Ignore error if column already exists
    });
    db.run(`ALTER TABLE paperwork ADD COLUMN rep_name TEXT`, (err) => {
        // Ignore error if column already exists
    });
});

console.log('Connected to SQLite database');
console.log('Database initialized');

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get all users
app.get('/api/users', (req, res) => {
    db.all('SELECT * FROM users ORDER BY name', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Add new user
app.post('/api/users', (req, res) => {
    const { name } = req.body;
    if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }

    db.run('INSERT OR IGNORE INTO users (name) VALUES (?)', [name], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ id: this.lastID, name: name });
    });
});

// Get all paperwork with history
app.get('/api/paperwork', (req, res) => {
    const query = `
        SELECT
            p.*,
            (SELECT COUNT(*) FROM scan_history WHERE paperwork_id = p.id) as scan_count
        FROM paperwork p
        ORDER BY p.created_at DESC
    `;

    db.all(query, [], (err, paperwork) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        // Get history for each paperwork
        const promises = paperwork.map(p => {
            return new Promise((resolve, reject) => {
                db.all(
                    'SELECT * FROM scan_history WHERE paperwork_id = ? ORDER BY timestamp DESC',
                    [p.id],
                    (err, history) => {
                        if (err) reject(err);
                        p.history = history || [];
                        // Parse order_ids from JSON string
                        try {
                            p.order_ids = JSON.parse(p.order_ids);
                        } catch (e) {
                            p.order_ids = [];
                        }
                        resolve(p);
                    }
                );
            });
        });

        Promise.all(promises)
            .then(results => res.json(results))
            .catch(err => res.status(500).json({ error: err.message }));
    });
});

// Get single paperwork by ID
app.get('/api/paperwork/:id', (req, res) => {
    const { id } = req.params;

    db.get('SELECT * FROM paperwork WHERE id = ?', [id], (err, paperwork) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!paperwork) {
            res.status(404).json({ error: 'Paperwork not found' });
            return;
        }

        // Parse order_ids
        try {
            paperwork.order_ids = JSON.parse(paperwork.order_ids);
        } catch (e) {
            paperwork.order_ids = [];
        }

        // Get history
        db.all(
            'SELECT * FROM scan_history WHERE paperwork_id = ? ORDER BY timestamp DESC',
            [id],
            (err, history) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                paperwork.history = history || [];
                res.json(paperwork);
            }
        );
    });
});

// Scan paperwork (create or transfer)
app.post('/api/scan', (req, res) => {
    const { company, customer_no, customer_name, rep_name, order_ids, user_name } = req.body;

    if (!company || !customer_no || !user_name) {
        res.status(400).json({ error: 'Company, customer_no, and user_name are required' });
        return;
    }

    // Check if there's an active return for this customer
    db.get(
        'SELECT * FROM paperwork WHERE customer_no = ? AND status = ?',
        [customer_no, 'active'],
        (err, existing) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }

            if (existing) {
                // Transfer existing paperwork to new holder
                db.run(
                    'UPDATE paperwork SET current_holder = ? WHERE id = ?',
                    [user_name, existing.id],
                    function(err) {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }

                        // Add to history
                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, action) VALUES (?, ?, ?)',
                            [existing.id, user_name, 'transfer'],
                            function(err) {
                                if (err) {
                                    res.status(500).json({ error: err.message });
                                    return;
                                }

                                res.json({
                                    success: true,
                                    action: 'transferred',
                                    paperwork_id: existing.id,
                                    message: `Paperwork transferred to ${user_name}`
                                });
                            }
                        );
                    }
                );
            } else {
                // Create new paperwork
                const orderIdsJson = JSON.stringify(order_ids || []);

                db.run(
                    `INSERT INTO paperwork (company, customer_no, customer_name, rep_name, order_ids, current_holder, status)
                     VALUES (?, ?, ?, ?, ?, ?, 'active')`,
                    [company, customer_no, customer_name || '', rep_name || '', orderIdsJson, user_name],
                    function(err) {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }

                        const paperworkId = this.lastID;

                        // Add to history as 'created'
                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, action) VALUES (?, ?, ?)',
                            [paperworkId, user_name, 'created'],
                            function(err) {
                                if (err) {
                                    res.status(500).json({ error: err.message });
                                    return;
                                }

                                res.json({
                                    success: true,
                                    action: 'created',
                                    paperwork_id: paperworkId,
                                    message: `New return created for ${customer_no}`
                                });
                            }
                        );
                    }
                );
            }
        }
    );
});

// Mark paperwork as complete
app.post('/api/paperwork/:id/complete', (req, res) => {
    const { id } = req.params;
    const { user_name } = req.body;

    if (!user_name) {
        res.status(400).json({ error: 'user_name is required' });
        return;
    }

    db.run(
        `UPDATE paperwork
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, completed_by = ?
         WHERE id = ?`,
        [user_name, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }

            // Add to history
            db.run(
                'INSERT INTO scan_history (paperwork_id, user_name, action) VALUES (?, ?, ?)',
                [id, user_name, 'completed'],
                function(err) {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }

                    res.json({ success: true, message: 'Paperwork marked as complete' });
                }
            );
        }
    );
});

// Reopen paperwork
app.post('/api/paperwork/:id/reopen', (req, res) => {
    const { id } = req.params;
    const { user_name } = req.body;

    if (!user_name) {
        res.status(400).json({ error: 'user_name is required' });
        return;
    }

    // Check if customer already has an active return
    db.get('SELECT customer_no FROM paperwork WHERE id = ?', [id], (err, paperwork) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        db.get(
            'SELECT id FROM paperwork WHERE customer_no = ? AND status = ? AND id != ?',
            [paperwork.customer_no, 'active', id],
            (err, existing) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }

                if (existing) {
                    res.status(400).json({
                        error: 'Customer already has an active return. Complete it first.'
                    });
                    return;
                }

                db.run(
                    `UPDATE paperwork
                     SET status = 'active', completed_at = NULL, completed_by = NULL, current_holder = ?
                     WHERE id = ?`,
                    [user_name, id],
                    function(err) {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }

                        // Add to history
                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, action) VALUES (?, ?, ?)',
                            [id, user_name, 'reopened'],
                            function(err) {
                                if (err) {
                                    res.status(500).json({ error: err.message });
                                    return;
                                }

                                res.json({ success: true, message: 'Paperwork reopened' });
                            }
                        );
                    }
                );
            }
        );
    });
});

// Transfer paperwork to another user
app.post('/api/paperwork/:id/transfer', (req, res) => {
    const { id } = req.params;
    const { user_name } = req.body;

    if (!user_name) {
        res.status(400).json({ error: 'user_name is required' });
        return;
    }

    db.run(
        'UPDATE paperwork SET current_holder = ? WHERE id = ?',
        [user_name, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }

            // Add to history
            db.run(
                'INSERT INTO scan_history (paperwork_id, user_name, action) VALUES (?, ?, ?)',
                [id, user_name, 'transfer'],
                function(err) {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }

                    res.json({ success: true, message: `Transferred to ${user_name}` });
                }
            );
        }
    );
});

// Reset database (for testing)
app.delete('/api/reset', (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM scan_history');
        db.run('DELETE FROM paperwork');
        db.run('DELETE FROM users');
    });
    res.json({ success: true, message: 'All data cleared' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the app at http://localhost:${PORT}`);
});
