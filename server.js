// server.js - Node.js Backend for Paperwork Tracker v2
// Features: Status tracking, Completion, Multiple returns per customer
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database('./paperwork.db', (err) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Connected to SQLite database');
        initDatabase();
    }
});

function initDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS paperwork (
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
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS scan_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            paperwork_id INTEGER NOT NULL,
            user_name TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            action TEXT DEFAULT 'scanned',
            FOREIGN KEY (paperwork_id) REFERENCES paperwork(id)
        )
    `);

    // Add columns for existing databases
    db.run(`ALTER TABLE paperwork ADD COLUMN status TEXT DEFAULT 'active'`, () => {});
    db.run(`ALTER TABLE paperwork ADD COLUMN completed_by TEXT`, () => {});
    db.run(`ALTER TABLE paperwork ADD COLUMN completed_at DATETIME`, () => {});

    console.log('Database initialized');
}

// Get all users
app.get('/api/users', (req, res) => {
    db.all('SELECT name FROM users ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(row => row.name));
    });
});

// Add user
app.post('/api/users', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    db.run('INSERT OR IGNORE INTO users (name) VALUES (?)', [name.trim()], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ name: name.trim() });
    });
});

// Get all paperwork
app.get('/api/paperwork', (req, res) => {
    const { status, customer_no } = req.query;
    
    let query = 'SELECT * FROM paperwork';
    let params = [];
    let conditions = [];

    if (status) {
        conditions.push('status = ?');
        params.push(status);
    }
    if (customer_no) {
        conditions.push('customer_no = ?');
        params.push(customer_no);
    }
    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at DESC';

    db.all(query, params, (err, paperworkRows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (paperworkRows.length === 0) return res.json([]);

        db.all('SELECT * FROM scan_history ORDER BY timestamp ASC', [], (err, historyRows) => {
            if (err) return res.status(500).json({ error: err.message });

            const paperwork = paperworkRows.map(row => {
                const history = historyRows
                    .filter(h => h.paperwork_id === row.id)
                    .map(h => ({
                        user: h.user_name,
                        timestamp: h.timestamp,
                        action: h.action || 'scanned'
                    }));

                return {
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
                    history: history
                };
            });

            res.json(paperwork);
        });
    });
});

// Create new paperwork (scan creates new document each time)
app.post('/api/scan', (req, res) => {
    const { company, customer_no, order_ids, user } = req.body;

    if (!company || !customer_no || !user) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const timestamp = new Date().toISOString();

    // Always create new document (allows multiple returns per customer)
    db.run(
        'INSERT INTO paperwork (company, customer_no, order_ids, current_holder, status, last_scan) VALUES (?, ?, ?, ?, ?, ?)',
        [company, customer_no, JSON.stringify(order_ids || []), user, 'active', timestamp],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });

            const paperworkId = this.lastID;

            db.run(
                'INSERT INTO scan_history (paperwork_id, user_name, timestamp, action) VALUES (?, ?, ?, ?)',
                [paperworkId, user, timestamp, 'created'],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ 
                        success: true, 
                        paperworkId,
                        message: 'New return created',
                        company,
                        customer_no,
                        order_ids: order_ids || []
                    });
                }
            );
        }
    );
});

// Transfer paperwork to another user (scan existing document)
app.post('/api/paperwork/:id/transfer', (req, res) => {
    const { id } = req.params;
    const { user } = req.body;

    if (!user) return res.status(400).json({ error: 'User is required' });

    const timestamp = new Date().toISOString();

    db.get('SELECT * FROM paperwork WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Paperwork not found' });
        if (row.status === 'completed') return res.status(400).json({ error: 'Cannot transfer completed paperwork' });

        db.run(
            'UPDATE paperwork SET current_holder = ?, last_scan = ? WHERE id = ?',
            [user, timestamp, id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });

                db.run(
                    'INSERT INTO scan_history (paperwork_id, user_name, timestamp, action) VALUES (?, ?, ?, ?)',
                    [id, user, timestamp, 'transferred'],
                    (err) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ success: true, message: 'Paperwork transferred' });
                    }
                );
            }
        );
    });
});

// Complete paperwork
app.post('/api/paperwork/:id/complete', (req, res) => {
    const { id } = req.params;
    const { user } = req.body;

    if (!user) return res.status(400).json({ error: 'User is required' });

    const timestamp = new Date().toISOString();

    db.get('SELECT * FROM paperwork WHERE id = ?', [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Paperwork not found' });
        if (row.status === 'completed') return res.status(400).json({ error: 'Already completed' });

        db.run(
            'UPDATE paperwork SET status = ?, completed_by = ?, completed_at = ?, last_scan = ? WHERE id = ?',
            ['completed', user, timestamp, timestamp, id],
            (err) => {
                if (err) return res.status(500).json({ error: err.message });

                db.run(
                    'INSERT INTO scan_history (paperwork_id, user_name, timestamp, action) VALUES (?, ?, ?, ?)',
                    [id, user, timestamp, 'completed'],
                    (err) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ 
                            success: true, 
                            message: 'Paperwork completed',
                            completed_by: user,
                            completed_at: timestamp
                        });
                    }
                );
            }
        );
    });
});

// Reopen completed paperwork
app.post('/api/paperwork/:id/reopen', (req, res) => {
    const { id } = req.params;
    const { user } = req.body;

    if (!user) return res.status(400).json({ error: 'User is required' });

    const timestamp = new Date().toISOString();

    db.run(
        'UPDATE paperwork SET status = ?, completed_by = NULL, completed_at = NULL, current_holder = ?, last_scan = ? WHERE id = ?',
        ['active', user, timestamp, id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });

            db.run(
                'INSERT INTO scan_history (paperwork_id, user_name, timestamp, action) VALUES (?, ?, ?, ?)',
                [id, user, timestamp, 'reopened'],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, message: 'Paperwork reopened' });
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

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

process.on('SIGINT', () => {
    db.close(() => {
        console.log('Database closed');
        process.exit(0);
    });
});
