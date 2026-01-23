// server.js - Node.js Backend for Paperwork Tracker
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite Database
const db = new sqlite3.Database('./paperwork.db', (err) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Connected to SQLite database');
        initDatabase();
    }
});

// Create tables if they don't exist
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
            last_scan DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(company, customer_no)
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

    console.log('Database initialized');
}

// API Routes

// Get all users
app.get('/api/users', (req, res) => {
    db.all('SELECT name FROM users ORDER BY name', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows.map(row => row.name));
    });
});

// Add or get user
app.post('/api/users', (req, res) => {
    const { name } = req.body;
    
    if (!name || !name.trim()) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }

    db.run('INSERT OR IGNORE INTO users (name) VALUES (?)', [name.trim()], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ name: name.trim() });
    });
});

// Get all paperwork
app.get('/api/paperwork', (req, res) => {
    const query = `
        SELECT p.*, GROUP_CONCAT(sh.user_name || '|' || sh.timestamp, '||') as history_data
        FROM paperwork p
        LEFT JOIN scan_history sh ON p.id = sh.paperwork_id
        GROUP BY p.id
        ORDER BY p.last_scan DESC
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }

        const paperwork = rows.map(row => {
            const history = [];
            if (row.history_data) {
                const entries = row.history_data.split('||');
                entries.forEach(entry => {
                    const [user, timestamp] = entry.split('|');
                    history.push({ user, timestamp, action: 'scanned' });
                });
            }

            return {
                id: row.id.toString(),
                company: row.company,
                customer_no: row.customer_no,
                order_ids: row.order_ids ? JSON.parse(row.order_ids) : [],
                current_holder: row.current_holder,
                last_scan: row.last_scan,
                created: row.created_at,
                history
            };
        });

        res.json(paperwork);
    });
});

// Scan paperwork (create or update)
app.post('/api/scan', (req, res) => {
    const { company, customer_no, order_ids, user } = req.body;

    if (!company || !customer_no || !user) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }

    const timestamp = new Date().toISOString();

    // Check if paperwork exists
    db.get(
        'SELECT id FROM paperwork WHERE company = ? AND customer_no = ?',
        [company, customer_no],
        (err, row) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }

            if (row) {
                // Update existing paperwork
                const paperworkId = row.id;
                
                db.run(
                    'UPDATE paperwork SET current_holder = ?, last_scan = ? WHERE id = ?',
                    [user, timestamp, paperworkId],
                    (err) => {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }

                        // Add to history
                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, timestamp) VALUES (?, ?, ?)',
                            [paperworkId, user, timestamp],
                            (err) => {
                                if (err) {
                                    res.status(500).json({ error: err.message });
                                    return;
                                }
                                res.json({ success: true, paperworkId });
                            }
                        );
                    }
                );
            } else {
                // Create new paperwork
                db.run(
                    'INSERT INTO paperwork (company, customer_no, order_ids, current_holder, last_scan) VALUES (?, ?, ?, ?, ?)',
                    [company, customer_no, JSON.stringify(order_ids || []), user, timestamp],
                    function(err) {
                        if (err) {
                            res.status(500).json({ error: err.message });
                            return;
                        }

                        const paperworkId = this.lastID;

                        // Add to history
                        db.run(
                            'INSERT INTO scan_history (paperwork_id, user_name, timestamp) VALUES (?, ?, ?)',
                            [paperworkId, user, timestamp],
                            (err) => {
                                if (err) {
                                    res.status(500).json({ error: err.message });
                                    return;
                                }
                                res.json({ success: true, paperworkId });
                            }
                        );
                    }
                );
            }
        }
    );
});

// Search paperwork
app.get('/api/paperwork/search', (req, res) => {
    const { q } = req.query;
    
    if (!q) {
        res.status(400).json({ error: 'Search query required' });
        return;
    }

    const searchTerm = `%${q}%`;
    
    db.all(
        `SELECT * FROM paperwork 
         WHERE company LIKE ? 
         OR customer_no LIKE ? 
         OR current_holder LIKE ?
         ORDER BY last_scan DESC`,
        [searchTerm, searchTerm, searchTerm],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json(rows);
        }
    );
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access the app at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Database connection closed');
        process.exit(0);
    });
});
