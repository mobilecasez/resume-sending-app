const dbConfig = require('../../db-config');

// Get all plans
const getPlans = async (req, res) => {
    try {
        const plans = await dbConfig.query('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC', []);
        
        // Parse features JSON string back to array
        const plansWithFeatures = plans.map(plan => ({
            ...plan,
            features: plan.features ? JSON.parse(plan.features) : []
        }));
        
        res.json({ success: true, plans: plansWithFeatures });
    } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).json({ error: 'Failed to fetch plans' });
    }
};

// Get user's credit balance and info
const getUserCredits = async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get credits from user_credits table (primary source)
        const userCredits = await dbConfig.get(`
            SELECT credits_remaining, credits_total, expiry_date, last_purchase_date
            FROM user_credits
            WHERE user_id = ?
        `, [userId]);
        
        // If no credit record exists, create one with 0 credits
        if (!userCredits) {
            await dbConfig.run(
                'INSERT INTO user_credits (user_id, credits_remaining, credits_total) VALUES (?, 0, 0)',
                [userId]
            );
            
            return res.json({
                success: true,
                balance: 0,
                credits: {
                    remaining: 0,
                    total: 0,
                    lastPurchaseDate: null,
                    expiryDate: null,
                    isExpired: false
                }
            });
        }
        
        // Check if credits are expired
        const now = new Date();
        const expiryDate = userCredits.expiry_date ? new Date(userCredits.expiry_date) : null;
        const isExpired = expiryDate && expiryDate < now;
        
        // Return credits
        res.json({
            success: true,
            balance: isExpired ? 0 : (userCredits.credits_remaining || 0),
            credits: {
                remaining: isExpired ? 0 : (userCredits.credits_remaining || 0),
                total: userCredits.credits_total || 0,
                lastPurchaseDate: userCredits.last_purchase_date,
                expiryDate: userCredits.expiry_date,
                isExpired: isExpired
            }
        });
    } catch (error) {
        console.error('Error fetching user credits:', error);
        res.status(500).json({ error: 'Failed to fetch credit balance' });
    }
};

// Purchase credits (simulated)
const purchaseCredits = async (req, res) => {
    const userId = req.user.id;
    const { planId, paymentMethod, transactionId } = req.body;
    
    if (!planId) {
        return res.status(400).json({ error: 'Plan ID is required' });
    }
    
    try {
        // Get plan details
        const plan = await dbConfig.get('SELECT * FROM plans WHERE id = ? AND is_active = 1', [planId]);
        
        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }
        
        const now = new Date();
        const validUntil = new Date(now.getTime() + plan.validity_days * 24 * 60 * 60 * 1000);
        
        // Insert transaction record
        await dbConfig.run(`
            INSERT INTO credit_transactions 
            (user_id, plan_id, credits_purchased, amount_paid, transaction_status, valid_from, valid_until, payment_method, transaction_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [userId, planId, plan.credits, plan.price, 'completed', now.toISOString(), validUntil.toISOString(), paymentMethod || 'simulated', transactionId || `TXN-${Date.now()}`]);
        
        // Update or create user credits
        const userCredits = await dbConfig.get('SELECT * FROM user_credits WHERE user_id = ?', [userId]);
        
        if (!userCredits) {
            // Create new credits record
            await dbConfig.run(`
        INSERT INTO user_credits (user_id, credits_remaining, credits_total, last_purchase_date, expiry_date)
        VALUES (?, ?, ?, ?, ?)
            `, [userId, plan.credits, plan.credits, now.toISOString(), validUntil.toISOString()]);
            
            return res.json({
        success: true,
        message: 'Credits purchased successfully',
        credits: {
            remaining: plan.credits,
            total: plan.credits,
            expiryDate: validUntil.toISOString()
        }
            });
        } else {
            // Update existing credits (add to existing balance if not expired)
            const currentExpiry = userCredits.expiry_date ? new Date(userCredits.expiry_date) : null;
            const isExpired = currentExpiry && currentExpiry < now;
            
            const newRemaining = isExpired ? plan.credits : userCredits.credits_remaining + plan.credits;
            const newTotal = userCredits.credits_total + plan.credits;
            const newExpiry = (currentExpiry && !isExpired && currentExpiry > validUntil) ? currentExpiry : validUntil;
            
            await dbConfig.run(`
        UPDATE user_credits 
        SET credits_remaining = ?, credits_total = ?, last_purchase_date = ?, expiry_date = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
            `, [newRemaining, newTotal, now.toISOString(), newExpiry.toISOString(), userId]);
            
            return res.json({
        success: true,
        message: 'Credits purchased successfully',
        credits: {
            remaining: newRemaining,
            total: newTotal,
            expiryDate: newExpiry.toISOString()
        }
            });
        }
    } catch (error) {
        console.error('Purchase credits error:', error);
        return res.status(500).json({ error: 'Failed to purchase credits' });
    }
};

// Get user's monthly usage statistics
const getUsageStats = async (req, res) => {
    const userId = req.user.id;
    
    console.log('📊 ============ USAGE STATS REQUEST START ============');
    console.log('📊 [USAGE STATS] User ID:', userId);
    console.log('📊 [USAGE STATS] Request time:', new Date().toISOString());
    
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1; // 1-12
    const currentYear = currentDate.getFullYear();
    const firstDayOfMonth = new Date(currentYear, currentMonth - 1, 1);
    const lastDayOfMonth = new Date(currentYear, currentMonth, 0);
    
    try {
        // First, check what's in the application_history table for this user
        const allHistory = await dbConfig.query('SELECT id, sent_date, company_name FROM application_history WHERE user_id = ? ORDER BY sent_date DESC LIMIT 10', [userId]);
        console.log('📊 [DB CHECK] Application history records for user:', allHistory ? allHistory.length : 0);
        if (allHistory && allHistory.length > 0) {
            console.log('📊 [DB CHECK] Sample records:', JSON.stringify(allHistory, null, 2));
            console.log('📊 [DB CHECK] Date range in records:');
            allHistory.forEach(record => {
                const date = new Date(record.sent_date);
                console.log(`   - ID ${record.id}: ${date.toISOString()} (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })})`);
            });
        } else {
            console.log('⚠️ [DB CHECK] No application_history records found for this user!');
        }
        
        // Get user's credit info
        console.log('📊 [DB QUERY] Fetching user_credits for user_id:', userId);
        const credits = await dbConfig.get('SELECT credits_remaining as "creditsRemaining", credits_total as "creditsTotal", expiry_date as "expiryDate" FROM user_credits WHERE user_id = ?', [userId]);
        console.log('📊 [DB RESULT] Credits query result:', JSON.stringify(credits, null, 2));
        
        const creditBalance = credits?.creditsRemaining || credits?.credits_remaining || 0;
        const creditTotal = credits?.creditsTotal || credits?.credits_total || 0;
        const expiryDate = credits?.expiryDate || credits?.expiry_date;
        
        console.log('📊 [CREDITS] Balance:', creditBalance, 'Total:', creditTotal, 'Expiry:', expiryDate);
        
        // Calculate expiring credits (credits expiring within 30 days)
        let expiringCredits = 0;
        let creditExpiryDate = null;
        if (expiryDate) {
            const expiryDateObj = new Date(expiryDate);
            const daysUntilExpiry = Math.floor((expiryDateObj - currentDate) / (1000 * 60 * 60 * 24));
            if (daysUntilExpiry <= 30 && daysUntilExpiry >= 0) {
        expiringCredits = creditBalance;
        creditExpiryDate = expiryDate;
            }
        }
        
        // Get current month's generated count from credit_usage_history
        const currentMonthGenerated = await dbConfig.get(`
            SELECT COUNT(*) as count
            FROM credit_usage_history
            WHERE user_id = ?
            AND action_type = 'cover_letter_generation'
            AND EXTRACT(MONTH FROM created_at) = ?
            AND EXTRACT(YEAR FROM created_at) = ?
        `, [userId, currentMonth, currentYear]);
        
        // Get current month's sent count from application_history
        const currentMonthSent = await dbConfig.get(`
            SELECT COUNT(*) as count
            FROM application_history
            WHERE user_id = ?
            AND EXTRACT(MONTH FROM sent_date) = ?
            AND EXTRACT(YEAR FROM sent_date) = ?
        `, [userId, currentMonth, currentYear]);
        
        const monthlyGenerated = currentMonthGenerated?.count || 0;
        const monthlySent = currentMonthSent?.count || 0;
        
        console.log('📊 [CURRENT MONTH] Month:', currentMonth, 'Year:', currentYear);
        console.log('📊 [CURRENT MONTH] Generated:', monthlyGenerated);
        console.log('📊 [CURRENT MONTH] Sent:', monthlySent);
        
        // Get credit history (transactions)
        const transactions = await dbConfig.query(`
            SELECT 
        description,
        credits_change as "creditsChange",
        balance_after as "balanceAfter",
        transaction_type as "transactionType",
        created_at as "transactionDate"
            FROM credit_transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
        `, [userId]);
        
        // Get date-wise activity for last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        // Get credits USED from credit_usage_history (actual usage)
        const dailyUsage = await dbConfig.query(`
            SELECT 
        DATE(created_at) as date,
        SUM(credits_used) as "creditsUsed"
            FROM credit_usage_history
            WHERE user_id = ? AND created_at >= ?
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `, [userId, thirtyDaysAgo.toISOString()]);
        
        // Get credits AVAILABLE from credit_transactions (balance)
        const dailyBalance = await dbConfig.query(`
            SELECT 
        DATE(created_at) as date,
        MAX(balance_after) as "creditsAvailable"
            FROM credit_transactions
            WHERE user_id = ? AND created_at >= ?
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `, [userId, thirtyDaysAgo.toISOString()]);
        
        // Create a map for quick lookup
        const activityMap = {};
        
        // Merge usage data
        if (dailyUsage && dailyUsage.length > 0) {
            dailyUsage.forEach(day => {
        // Keep date as-is from database
        let dateStr;
        if (typeof day.date === 'string') {
            dateStr = day.date;
        } else if (day.date instanceof Date) {
            const year = day.date.getFullYear();
            const month = String(day.date.getMonth() + 1).padStart(2, '0');
            const dayNum = String(day.date.getDate()).padStart(2, '0');
            dateStr = `${year}-${month}-${dayNum}`;
        }
        if (!activityMap[dateStr]) activityMap[dateStr] = { creditsUsed: 0, creditsAvailable: 0 };
        activityMap[dateStr].creditsUsed = day.creditsUsed || 0;
            });
        }
        
        // Merge balance data
        if (dailyBalance && dailyBalance.length > 0) {
            dailyBalance.forEach(day => {
        // Keep date as-is from database
        let dateStr;
        if (typeof day.date === 'string') {
            dateStr = day.date;
        } else if (day.date instanceof Date) {
            const year = day.date.getFullYear();
            const month = String(day.date.getMonth() + 1).padStart(2, '0');
            const dayNum = String(day.date.getDate()).padStart(2, '0');
            dateStr = `${year}-${month}-${dayNum}`;
        }
        if (!activityMap[dateStr]) activityMap[dateStr] = { creditsUsed: 0, creditsAvailable: 0 };
        activityMap[dateStr].creditsAvailable = day.creditsAvailable || 0;
            });
        }
        
        // Generate date-wise data for last 30 days
        const dateWiseData = [];
        for (let i = 29; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            // Use local date components to match database DATE(created_at) which uses server timezone
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            const dayData = activityMap[dateStr] || { creditsUsed: 0, creditsAvailable: 0 };
            
            dateWiseData.push({
        date: dateStr,
        dateFormatted: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        generated: 0,
        sent: 0,
        creditsUsed: dayData.creditsUsed,
        creditsAvailable: dayData.creditsAvailable // Will be filled from actual transaction balances
            });
        }
        
        // Get balance history from all credit events (purchases + usages)
        console.log('🔍 [USAGE STATS] Querying balance history from all credit events...');
        
        // Get balance from credit_transactions (purchases, refunds) - has balance_after
        const balanceFromPurchases = await dbConfig.query(
          `SELECT DATE(created_at) as date, 
                  MAX(balance_after) as balance_at_end_of_day
           FROM credit_transactions
           WHERE user_id = ? AND created_at >= ?
           GROUP BY DATE(created_at)
           ORDER BY date DESC`,
          [userId, thirtyDaysAgo.toISOString()]
        );
        
        // For credit_usage_history, we need to calculate balance by subtracting usage from current balance
        // We'll get the total credits used per day, then work backwards from current balance
        const usagePerDay = await dbConfig.query(
          `SELECT DATE(created_at) as date,
                  SUM(credits_used) as total_used
           FROM credit_usage_history
           WHERE user_id = ? AND created_at >= ?
           GROUP BY DATE(created_at)
           ORDER BY date ASC`,
          [userId, thirtyDaysAgo.toISOString()]
        );
        
        console.log('📊 [USAGE STATS] Balance from purchases:', balanceFromPurchases?.length || 0, 'days');
        console.log('📊 [USAGE STATS] Usage per day:', usagePerDay?.length || 0, 'days');
        
        // Build balance map from purchases first
        const balanceMap = {};
        if (balanceFromPurchases) {
          balanceFromPurchases.forEach(b => {
            // Keep date as-is from database (don't convert to UTC)
            let dateStr;
            if (typeof b.date === 'string') {
                dateStr = b.date;
            } else if (b.date instanceof Date) {
                const year = b.date.getFullYear();
                const month = String(b.date.getMonth() + 1).padStart(2, '0');
                const day = String(b.date.getDate()).padStart(2, '0');
                dateStr = `${year}-${month}-${day}`;
            }
            balanceMap[dateStr] = parseInt(b.balance_at_end_of_day) || 0;
          });
        }
        
        // For days with only usage (no purchase), we need to calculate backwards from current balance
        // Sort dateWiseData chronologically and fill in balances
        let runningBalance = creditBalance;
        for (let i = dateWiseData.length - 1; i >= 0; i--) {
          const day = dateWiseData[i];
          
          // If we have a recorded balance from purchase on this day, use it
          if (balanceMap[day.date]) {
            runningBalance = balanceMap[day.date];
            day.creditsAvailable = runningBalance;
          } else {
            // Otherwise use the running balance from future days
            day.creditsAvailable = runningBalance;
            
            // Find usage for this day
            const dayUsage = usagePerDay?.find(u => {
              // Keep date as-is from database (don't convert to UTC)
              let usageDate;
              if (typeof u.date === 'string') {
                  usageDate = u.date;
              } else if (u.date instanceof Date) {
                  const year = u.date.getFullYear();
                  const month = String(u.date.getMonth() + 1).padStart(2, '0');
                  const day = String(u.date.getDate()).padStart(2, '0');
                  usageDate = `${year}-${month}-${day}`;
              }
              return usageDate === day.date;
            });
            
            if (dayUsage && dayUsage.total_used) {
              // Subtract this day's usage to get balance at start of day
              runningBalance += parseInt(dayUsage.total_used) || 0;
            }
          }
        }
        
        console.log('📊 [USAGE STATS] Balance history calculated for all 30 days');
        
        // Get GENERATED counts per day from credit_usage_history
        console.log('🔍 [USAGE STATS] Querying credit_usage_history for generations...');
        
    const generationStats = await dbConfig.query(
      `SELECT DATE(created_at) as date, COUNT(*) as generated
       FROM credit_usage_history
       WHERE user_id = ? 
         AND created_at >= ?
         AND action_type = 'cover_letter_generation'
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [userId, thirtyDaysAgo.toISOString()]
    );
        // Get SENT counts per day from application_history
        console.log('🔍 [USAGE STATS] Querying application_history for sends...');
        
    const sendStats = await dbConfig.query(
      `SELECT DATE(sent_date) as date, COUNT(*) as sent
       FROM application_history
       WHERE user_id = ? AND sent_date >= ? AND deleted_at IS NULL
       GROUP BY DATE(sent_date)
       ORDER BY date DESC`,
      [userId, thirtyDaysAgo.toISOString()]
    );
        // Merge generation stats into dateWiseData
        if (generationStats && generationStats.length > 0) {
            console.log('✅ [USAGE STATS] Merging generation stats');
            generationStats.forEach(stat => {
        // Keep date as-is from database (already in correct format YYYY-MM-DD)
        let statDate;
        if (typeof stat.date === 'string') {
            statDate = stat.date;
        } else if (stat.date instanceof Date) {
            // Format date using local timezone components (don't use toISOString!)
            const year = stat.date.getFullYear();
            const month = String(stat.date.getMonth() + 1).padStart(2, '0');
            const day = String(stat.date.getDate()).padStart(2, '0');
            statDate = `${year}-${month}-${day}`;
        }
        const dayIndex = dateWiseData.findIndex(d => d.date === statDate);
        console.log(`   - Generated: Date ${statDate}, Count ${stat.generated}, Index ${dayIndex}`);
        if (dayIndex >= 0) {
            dateWiseData[dayIndex].generated = stat.generated || 0;
        }
            });
        } else {
            console.log('⚠️ [USAGE STATS] No generation data found!');
        }
        
        // Merge send stats into dateWiseData
        if (sendStats && sendStats.length > 0) {
            console.log('✅ [USAGE STATS] Merging send stats');
            sendStats.forEach(stat => {
        // Keep date as-is from database (already in correct format YYYY-MM-DD)
        let statDate;
        if (typeof stat.date === 'string') {
            statDate = stat.date;
        } else if (stat.date instanceof Date) {
            // Format date using local timezone components (don't use toISOString!)
            const year = stat.date.getFullYear();
            const month = String(stat.date.getMonth() + 1).padStart(2, '0');
            const day = String(stat.date.getDate()).padStart(2, '0');
            statDate = `${year}-${month}-${day}`;
        }
        const dayIndex = dateWiseData.findIndex(d => d.date === statDate);
        console.log(`   - Sent: Date ${statDate}, Count ${stat.sent}, Index ${dayIndex}`);
        if (dayIndex >= 0) {
            dateWiseData[dayIndex].sent = stat.sent || 0;
        }
            });
        } else {
            console.log('⚠️ [USAGE STATS] No send data found!');
        }
        
        // Log final data before sending
        console.log('📤 [USAGE STATS] Sending response with dateWiseActivity count:', dateWiseData.length);
        const nonZeroDays = dateWiseData.filter(d => d.generated > 0 || d.sent > 0);
        console.log('📤 [USAGE STATS] Days with activity (non-zero):', nonZeroDays.length);
        if (nonZeroDays.length > 0) {
            console.log('📤 [USAGE STATS] Sample activity days:', JSON.stringify(nonZeroDays.slice(0, 3), null, 2));
        }
        
        res.json({
            success: true,
            credits: {
                remaining: creditBalance,
                total: creditTotal,
                expiring: expiringCredits,
                expiryDate: creditExpiryDate
            },
            currentMonth: {
                month: currentMonth,
                year: currentYear,
                lettersGenerated: monthlyGenerated,
                lettersSent: monthlySent
            },
            history: [],
            creditHistory: transactions || [],
            dateWiseActivity: dateWiseData
        });
    } catch (error) {
        console.error('Usage stats error:', error);
        return res.status(500).json({ error: 'Failed to fetch usage statistics' });
    }
};

// Get detailed credit usage history
const getCreditHistory = async (req, res) => {
    const userId = req.user.id;
    const { limit = 50 } = req.query;
    
    try {
        const history = await dbConfig.query(`
            SELECT 
        id,
        credits_used as "creditsUsed",
        action_type as "actionType",
        company_name as "companyName",
        position,
        recipient_email as "recipientEmail",
        created_at as "createdAt"
            FROM credit_usage_history
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `, [userId, parseInt(limit)]);
        
        res.json({ success: true, history: history || [] });
    } catch (error) {
        console.error('Error fetching credit history:', error);
        return res.status(500).json({ error: 'Failed to fetch credit history' });
    }
};

// Get purchase/transaction history
const getPurchaseHistory = async (req, res) => {
    const userId = req.user.id;
    
    try {
        const transactions = await dbConfig.query(`
            SELECT 
        ct.id,
        ct.credits_purchased as "creditsPurchased",
        ct.amount_paid as "amountPaid",
        ct.transaction_status as "transactionStatus",
        ct.transaction_date as "transactionDate",
        ct.valid_from as "validFrom",
        ct.valid_until as "validUntil",
        ct.payment_method as "paymentMethod",
        ct.transaction_id as "transactionId",
        p.name as "planName"
            FROM credit_transactions ct
            LEFT JOIN plans p ON ct.plan_id = p.id
            WHERE ct.user_id = ?
            ORDER BY ct.transaction_date DESC
        `, [userId]);
        
        res.json({ success: true, transactions: transactions || [] });
    } catch (error) {
        console.error('Error fetching purchase history:', error);
        return res.status(500).json({ error: 'Failed to fetch purchase history' });
    }
};

module.exports = {
    getPlans,
    getUserCredits,
    purchaseCredits,
    getUsageStats,
    getCreditHistory,
    getPurchaseHistory
};
