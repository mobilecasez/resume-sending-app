const dbConfig = require('../../db-config');

// Get usage statistics for a user
const getUsageStats = async (req, res) => {
    try {
        const userId = req.user.id;
        
        console.log('📊 Fetching usage stats for user:', userId);
        
        // Get user's counters
        const user = await dbConfig.get(
            'SELECT total_generated, total_sent FROM users WHERE id = ?',
            [userId]
        );
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get user's current credit balance
        const userCredit = await dbConfig.get(
            'SELECT credits_remaining, expiry_date FROM user_credits WHERE user_id = ?',
            [userId]
        );
        
        const creditsRemaining = userCredit?.credits_remaining || 0;
        
        // Get credit transactions for history
        const creditHistory = await dbConfig.query(
            `SELECT 
                id,
                transaction_type as "transactionType",
                credits_change as "creditsChange",
                description,
                created_at as "transactionDate",
                balance_after as "balanceAfter"
            FROM credit_transactions 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT 20`,
            [userId]
        );
        
        // Get current month's activity (simplified - just return total counts)
        const currentMonth = {
            lettersGenerated: user.total_generated || 0,
            lettersSent: user.total_sent || 0
        };
        
        // Get date-wise activity (last 30 days)
        const dateWiseActivity = await dbConfig.query(
            `SELECT 
                DATE(sent_date) as date,
                COUNT(*) as count
            FROM application_history 
            WHERE user_id = ? 
            AND sent_date >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY DATE(sent_date)
            ORDER BY date DESC`,
            [userId]
        );
        
        res.json({
            success: true,
            credits: {
                remaining: creditsRemaining,
                expiring: 0,
                expiryDate: userCredit?.expiry_date || null
            },
            currentMonth,
            dateWiseActivity: dateWiseActivity || [],
            creditHistory: creditHistory || []
        });
        
    } catch (error) {
        console.error('❌ Error fetching usage stats:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

module.exports = {
    getUsageStats
};
