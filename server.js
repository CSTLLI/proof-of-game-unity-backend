const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const db = mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root",
    database: process.env.DB_NAME || "proof_of_game_db",
    port: process.env.DB_PORT || 3307,
});

db.connect((err) => {
    if (err) {
        console.error("Error connecting to the database:", err);
        return;
    }
    console.log("Connected to database");
});

// Routes

// Create new user
app.post("/api/auth/register", async (req, res) => {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
        return res
            .status(400)
            .json({ error: "Username and password are required" });
    }

    try {
        // Check if username already exists
        const checkUser = "SELECT id FROM users WHERE username = ?";
        db.query(checkUser, [username], async (err, results) => {
            if (err) {
                console.error("Database error:", err);
                return res.status(500).json({ error: "Internal server error" });
            }

            if (results.length > 0) {
                return res.status(409).json({ error: "Username already exists" });
            }

            // Hash password
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(password, saltRounds);

            // Insert new user with free subscription (basic tier)
            const insertUser = "INSERT INTO users (username, password, subscription_type, subscription_expiry) VALUES (?, ?, 'free', DATE_ADD(NOW(), INTERVAL 30 DAY))";
            db.query(insertUser, [username, hashedPassword], async (err, result) => {
                if (err) {
                    console.error("Database error:", err);
                    return res.status(500).json({ error: "Internal server error" });
                }

                // Initialize player stats
                // const initStats =
                //     "INSERT INTO player_stats (player_id, games_played, wins, losses, score) VALUES (?, 0, 0, 0, 0)";
                // db.query(initStats, [result.insertId], (err) => {
                //     if (err) {
                //         console.error("Error initializing player stats:", err);
                //         // Note: User is still created even if stats initialization fails
                //     }
                // });

                res.status(201).json({
                    success: true,
                    message: "User created successfully",
                    userId: result.insertId,
                });
            });
        });
    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Authentication
app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res
            .status(400)
            .json({ error: "Username and password are required" });
    }

    const query = "SELECT u.*, s.subscription_type, s.subscription_expiry FROM users u LEFT JOIN subscriptions s ON u.id = s.user_id WHERE u.username = ?";

    db.query(query, [username], async (err, results) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).json({ error: "Internal server error" });
        }

        if (results.length === 0) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const user = results[0];
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Check subscription status
        const subscriptionActive = user.subscription_expiry && new Date(user.subscription_expiry) > new Date();

        // Send user data (excluding password)
        const { password: _, ...userData } = user;
        res.json({
            success: true,
            user: {
                ...userData,
                subscriptionActive
            }
        });
    });
});

// Get player statistics
app.get('/api/players/stats', (req, res) => {
    const query = `
        SELECT 
            u.username as playerName,
            s.games_played as gamesPlayed,
            s.wins as gamesWon,
            s.losses as gamesLost,
            s.score
        FROM users u
        JOIN player_stats s ON u.id = s.player_id
        ORDER BY s.score DESC
    `;

    db.query(query, (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }

        res.json({ stats: results });
    });
});

// Get user game history
app.get('/api/games/history/:userId', (req, res) => {
    const { userId } = req.params;
    
    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }
    
    const query = `
        SELECT 
            g.id,
            g.scenario_name,
            g.completed,
            g.completed_tasks,
            g.total_tasks,
            g.risk_level,
            g.time_taken,
            g.blockchain_mode,
            g.created_at
        FROM game_sessions g
        WHERE g.player_id = ?
        ORDER BY g.created_at DESC
        LIMIT 10
    `;
    
    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
        
        res.json({ success: true, games: results });
    });
});

// Start a new game session
app.post('/api/games/start', (req, res) => {
    const { userId, scenarioName } = req.body;
    
    if (!userId || !scenarioName) {
        return res.status(400).json({ error: "User ID and scenario name are required" });
    }
    
    // Check subscription status
    const checkSubscription = "SELECT subscription_type, subscription_expiry FROM users WHERE id = ?";
    db.query(checkSubscription, [userId], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (results.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        
        const user = results[0];
        const subscriptionActive = user.subscription_expiry && new Date(user.subscription_expiry) > new Date();
        
        // If premium content, check if user has active subscription
        const isPremiumScenario = scenarioName.toLowerCase().includes('premium');
        if (isPremiumScenario && (!subscriptionActive || user.subscription_type === 'free')) {
            return res.status(403).json({ error: "This scenario requires an active premium subscription" });
        }
        
        // Create new game session
        const query = `
            INSERT INTO game_sessions 
            (player_id, scenario_name, started_at, blockchain_mode, completed, completed_tasks, total_tasks) 
            VALUES (?, ?, NOW(), 0, 0, 0, 0)
        `;
        
        db.query(query, [userId, scenarioName], (err, result) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Internal server error' });
            }
            
            res.json({ 
                success: true, 
                gameId: result.insertId,
                message: "Game session started"
            });
        });
    });
});

// Complete a game session
app.post('/api/games/complete', (req, res) => {
    const { 
        gameId, 
        userId, 
        completed,
        completedTasks, 
        totalTasks, 
        timeTaken, 
        riskLevel,
        blockchainMode 
    } = req.body;
    
    if (!gameId || !userId) {
        return res.status(400).json({ error: "Game ID and User ID are required" });
    }
    
    // Update game session
    const updateGame = `
        UPDATE game_sessions 
        SET 
            completed = ?,
            completed_tasks = ?,
            total_tasks = ?,
            time_taken = ?,
            risk_level = ?,
            blockchain_mode = ?,
            completed_at = NOW()
        WHERE id = ? AND player_id = ?
    `;
    
    db.query(updateGame, [
        completed ? 1 : 0,
        completedTasks,
        totalTasks,
        timeTaken,
        riskLevel,
        blockchainMode ? 1 : 0,
        gameId,
        userId
    ], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Game session not found or not owned by user" });
        }
        
        // Update player stats
        const getStats = "SELECT * FROM player_stats WHERE player_id = ?";
        db.query(getStats, [userId], (err, results) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Internal server error' });
            }
            
            if (results.length === 0) {
                // Create stats if not exist
                const initStats = `
                    INSERT INTO player_stats 
                    (player_id, games_played, wins, losses, score) 
                    VALUES (?, 1, ?, ?, ?)
                `;
                const isWin = completed && completedTasks === totalTasks;
                const score = isWin ? (completedTasks * 10) - Math.round(riskLevel) : 0;
                
                db.query(initStats, [
                    userId, 
                    isWin ? 1 : 0, 
                    isWin ? 0 : 1,
                    score
                ]);
            } else {
                // Update existing stats
                const stats = results[0];
                const isWin = completed && completedTasks === totalTasks;
                const scoreAdd = isWin ? (completedTasks * 10) - Math.round(riskLevel) : 0;
                
                const updateStats = `
                    UPDATE player_stats 
                    SET 
                        games_played = games_played + 1,
                        wins = wins + ?,
                        losses = losses + ?,
                        score = score + ?
                    WHERE player_id = ?
                `;
                
                db.query(updateStats, [
                    isWin ? 1 : 0,
                    isWin ? 0 : 1,
                    scoreAdd,
                    userId
                ]);
            }
            
            res.json({ 
                success: true, 
                message: "Game session completed and stats updated"
            });
        });
    });
});

// Subscription management
app.post('/api/subscriptions/upgrade', (req, res) => {
    const { userId, subscriptionType } = req.body;
    
    if (!userId || !subscriptionType) {
        return res.status(400).json({ error: "User ID and subscription type are required" });
    }
    
    // In a real app, you would process payment here
    
    // Set expiry date based on subscription type
    let expiryDays = 30; // Default for monthly
    if (subscriptionType === 'yearly') {
        expiryDays = 365;
    }
    
    const query = `
        INSERT INTO subscriptions (user_id, subscription_type, subscription_expiry)
        VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ${expiryDays} DAY))
        ON DUPLICATE KEY UPDATE 
            subscription_type = VALUES(subscription_type),
            subscription_expiry = VALUES(subscription_expiry)
    `;
    
    db.query(query, [userId, subscriptionType], (err, result) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
        
        res.json({
            success: true,
            message: "Subscription upgraded successfully",
            subscriptionType,
            expiryDate: new Date(Date.now() + (expiryDays * 24 * 60 * 60 * 1000))
        });
    });
});

app.get("/api/feedback/last/:userId", (req, res) => {
    const { userId } = req.params;

    if (!userId) {
        return res.status(400).json({ error: "User ID is required" });
    }

    const query =
        "SELECT id, comment, created_at FROM player_feedback WHERE player_id = ? ORDER BY created_at DESC LIMIT 1";

    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).json({ error: "Internal server error" });
        }

        if (results.length === 0) {
            return res.json({ success: true, feedback: null });
        }

        res.json({ success: true, feedback: results[0] });
    });
});

// Save player feedback
app.post("/api/feedback", (req, res) => {
    const { playerId, comment } = req.body;

    if (!playerId || !comment) {
        return res
            .status(400)
            .json({ error: "Player ID and comment are required" });
    }

    const query =
        "INSERT INTO player_feedback (player_id, comment, created_at) VALUES (?, ?, NOW())";

    db.query(query, [playerId, comment], (err, result) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).json({ error: "Internal server error" });
        }

        res.json({
            success: true,
            feedbackId: result.insertId,
        });
    });
});

app.put("/api/feedback/:feedbackId", (req, res) => {
    const { feedbackId } = req.params;
    const { comment } = req.body;

    if (!feedbackId || !comment) {
        return res.status(400).json({ error: "Feedback ID and comment are required" });
    }

    const query = "UPDATE player_feedback SET comment = ? WHERE id = ?";

    db.query(query, [comment, feedbackId], (err) => {
        if (err) {
            console.error("Database error:", err);
            return res.status(500).json({ error: "Internal server error" });
        }

        res.json({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});