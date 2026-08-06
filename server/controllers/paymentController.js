const Razorpay = require('razorpay');
const crypto = require('crypto');
const { notifyCreditsAdded } = require('./notificationsController');

// Initialize Razorpay instance
let razorpayInstance = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    razorpayInstance = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    console.log('✅ Razorpay initialized successfully');
} else {
    console.warn('⚠️  Razorpay credentials not found. Payment endpoints will not work.');
}

/**
 * Create Razorpay order
 */
async function createOrder(req, res, dbConfig) {
    // Support both planId (new) and packageId (legacy) for backward compatibility
    const { planId, packageId, amount } = req.body;
    
    // 🔍 DEBUG: Log token payload to see what we have
    console.log('🔑 Auth Token Payload:', req.user);
    
    const userId = req.user.id || req.user.userId; // Handle different token structures
    const actualPlanId = planId || packageId; // Use planId if present, otherwise fall back to packageId

    console.log(`💳 Processing Order for User ID: ${userId} | Plan: ${actualPlanId} | Amount: ${amount}`);

    try {
        if (!razorpayInstance) {
            return res.status(503).json({ 
                error: 'Payment service not configured. Please contact support.' 
            });
        }

        // 1. 🔥 FETCH USER DETAILS FROM DATABASE (Source of Truth)
        console.log('📋 Fetching user details for prefill from DB...');
        
        // Initialize fallback values from token
        let userName = req.user.name || req.user.fullName || 'User';
        let userEmail = req.user.email || '';
        let cleanPhone = '';
        
        try {
            const userResult = await dbConfig.get(
                'SELECT email, phone_number, full_name FROM users WHERE id = ?',
                [userId]
            );
        
            if (userResult) {
                // Override with DB values if present
                userName = userResult.full_name || userName;
                userEmail = userResult.email || userEmail;
                cleanPhone = (userResult.phone_number || '').replace(/[^0-9]/g, '');
                
                console.log('✅ Found User in DB:', {
                    name: userName,
                    email: userEmail,
                    phone: cleanPhone ? cleanPhone.substring(0, 3) + '***' : 'MISSING'
                });
            } else {
                console.warn(`⚠️ User ID ${userId} not found in DB. Using Token data.`);
            }
        } catch (dbError) {
            console.error('⚠️ DB User Lookup Failed:', dbError.message);
            console.log('📋 Continuing with token data:', { userName, userEmail });
        }
        
        // Warn if phone is missing (Razorpay will ask for it)
        if (!cleanPhone) {
            console.warn('⚠️⚠️ NO PHONE NUMBER - Razorpay will prompt user to enter it ⚠️⚠️');
        }

        // Validate package exists and get details
        const packageResult = await dbConfig.get(
            'SELECT * FROM plans WHERE id = ? AND is_active = 1',
            [actualPlanId]
        );

        if (!packageResult) {
            return res.status(404).json({ error: 'Package not found or inactive' });
        }

        const packageData = packageResult;

        // Verify amount matches package price (handle both string and number types)
        const packagePrice = parseFloat(packageData.price);
        const requestAmount = parseFloat(amount);
        if (Math.abs(packagePrice - requestAmount) > 0.01) {
            return res.status(400).json({ error: 'Invalid amount' });
        }

        // Create Razorpay order
        // Note: Razorpay test mode only supports INR, so we convert USD to INR
        // In production, enable international payments on Razorpay dashboard for USD support
        const USD_TO_INR_RATE = 83; // Approximate conversion rate
        const amountInINR = Math.round(amount * USD_TO_INR_RATE);
        
        const options = {
            amount: amountInINR * 100, // Amount in paise (Razorpay uses smallest currency unit)
            currency: 'INR', // Razorpay test mode only supports INR
            receipt: `rcpt_${Date.now()}_${userId}_${actualPlanId}`,
            notes: {
                userId: userId,
                packageId: actualPlanId,
                planId: actualPlanId,
                packageName: packageData.name,
                credits: packageData.credits,
                originalAmount: amount,
                originalCurrency: 'USD',
                convertedAmount: amountInINR,
                convertedCurrency: 'INR',
                conversionRate: USD_TO_INR_RATE,
                userEmail: userEmail,
                userName: userName,
                userPhone: cleanPhone
            }
        };

        console.log('📋 Creating Razorpay order with notes:', options.notes);
        const order = await razorpayInstance.orders.create(options);

        console.log('✅ Razorpay order created:', order.id);

        // 🔍 DEBUGGING BLOCK - Store order in database with detailed error handling
        try {
            console.log('📝 Attempting DB Insert with values:', {
                order_id: order.id,
                user_id: userId,
                plan_id: actualPlanId,
                amount: amount,
                currency: 'INR'
            });

            await dbConfig.run(`
                INSERT INTO payment_orders (
                    order_id, user_id, package_id, plan_id, amount, currency,
                    status, razorpay_order_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                order.id,
                userId,
                actualPlanId,
                actualPlanId,
                amount,
                'INR',
                'created',
                order.id
            ]);

            console.log('✅ Order saved to database successfully');
            
        } catch (dbError) {
            console.error('❌❌❌ DATABASE INSERT FAILED ❌❌❌');
            console.error('Full Error Object:', dbError);
            console.error('Error Message:', dbError.message);
            console.error('❌❌❌ END OF ERROR LOG ❌❌❌');
            
            // Return error immediately so frontend knows to stop
            const IS_PRODUCTION = process.env.NODE_ENV === 'production';
            return res.status(500).json({ 
                error: 'Database error: Unable to save order. Please contact support.',
                debug: IS_PRODUCTION ? undefined : {
                    message: dbError.message,
                    code: dbError.code
                }
            });
        }

        // 3. 🔥 RETURN USER DETAILS FOR PREFILL
        console.log('📤 Sending response with prefill data:', {
            name: userName,
            email: userEmail,
            contact: cleanPhone ? '***' + cleanPhone.slice(-4) : 'NONE'
        });
        
        res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
            // Include user details for frontend to use in prefill
            prefill: {
                name: userName,
                email: userEmail,
                contact: cleanPhone
            }
        });

    } catch (error) {
        console.error('❌ Create Order Fatal Error:', error);
        res.status(500).json({ 
            error: 'Failed to create payment order',
            message: error.message 
        });
    }
}

/**
 * Verify Razorpay payment signature
 */
async function verifyPayment(req, res, dbConfig) {
    const { 
        razorpay_order_id, 
        razorpay_payment_id, 
        razorpay_signature 
    } = req.body;
    const userId = req.user.id;

    try {
        if (!razorpayInstance) {
            return res.status(503).json({ 
                error: 'Payment service not configured' 
            });
        }

        // Verify signature
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        const isValidSignature = expectedSignature === razorpay_signature;

        if (!isValidSignature) {
            // Update order status as failed
            await dbConfig.run(`
                UPDATE payment_orders 
                SET status = 'failed', updated_at = CURRENT_TIMESTAMP
                WHERE order_id = ? AND user_id = ?
            `, [razorpay_order_id, userId]);

            return res.status(400).json({ 
                success: false, 
                error: 'Payment verification failed' 
            });
        }

        // Signature is valid - fetch order details
        console.log('✅ Signature verified, fetching order details...');
        const orderResult = await dbConfig.get(`
            SELECT po.*, p.credits, p.validity_days, p.name as package_name
            FROM payment_orders po
            JOIN plans p ON po.package_id = p.id
            WHERE po.order_id = ? AND po.user_id = ?
        `, [razorpay_order_id, userId]);
        
        console.log('📦 Order result:', orderResult);
        
        if (!orderResult) {
            console.error('❌ Order not found for:', { razorpay_order_id, userId });
            return res.status(404).json({ error: 'Order not found' });
        }

        const orderData = orderResult;

        // Update payment order status
        await dbConfig.run(`
            UPDATE payment_orders 
            SET status = 'completed', 
                payment_id = ?,
                signature = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE order_id = ? AND user_id = ?
        `, [razorpay_payment_id, razorpay_signature, razorpay_order_id, userId]);

        // Add credits to user account in user_credits table
        console.log('💳 Adding credits:', { credits: orderData.credits, userId });
        
        // Check if user has a credit record
        const existingCredits = await dbConfig.get(
            'SELECT * FROM user_credits WHERE user_id = ?',
            [userId]
        );
        
        if (!existingCredits) {
            // Create new credit record
            console.log('Creating new credit record for user:', userId);
            await dbConfig.run(`
                INSERT INTO user_credits (user_id, credits_remaining, credits_total, last_purchase_date)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `, [userId, orderData.credits, orderData.credits]);
        } else {
            // Update existing credit record
            console.log('Updating existing credits. Current:', existingCredits.credits_remaining);
            await dbConfig.run(`
                UPDATE user_credits 
                SET credits_remaining = credits_remaining + ?,
                    credits_total = credits_total + ?,
                    last_purchase_date = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ?
            `, [orderData.credits, orderData.credits, userId]);
        }

        // Create transaction record
        await dbConfig.run(`
            INSERT INTO credit_transactions (
                user_id, transaction_type, credits_change, description, 
                balance_after, created_at
            ) VALUES (?, ?, ?, ?, 
                (SELECT credits_remaining FROM user_credits WHERE user_id = ?),
                CURRENT_TIMESTAMP
            )
        `, [
            userId,
            'purchase',
            orderData.credits,
            `Purchased ${orderData.package_name} - Payment ID: ${razorpay_payment_id}`,
            userId
        ]);

        // Fetch updated user data from user_credits
        const userData = await dbConfig.get(
            'SELECT credits_remaining as credits FROM user_credits WHERE user_id = ?',
            [userId]
        );
        
        console.log('✅ Credits added successfully! New balance:', userData?.credits);
        try { await notifyCreditsAdded(userId, orderData.credits, (userData.credits - orderData.credits), userData.credits, 'purchase'); } catch (_) {}
        try { require('../services/adminNotifier').notifyNewPurchase(userId, { credits: orderData.credits, amount: (orderData.amount != null ? orderData.amount / 100 : null), currency: orderData.currency || 'INR', source: 'Razorpay' }).catch(() => {}); } catch (_) {}

        res.json({
            success: true,
            message: 'Payment successful!',
            credits: userData.credits,
            creditsAdded: orderData.credits,
            packageName: orderData.package_name,
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id
        });

    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ 
            error: 'Payment verification failed',
            message: error.message 
        });
    }
}

/**
 * Get payment order status
 */
async function getOrderStatus(req, res, dbConfig) {
    const { orderId } = req.params;
    const userId = req.user.id;

    try {
        // First check our database
        const dbOrder = await dbConfig.get(`
            SELECT po.*, p.credits, p.name as package_name
            FROM payment_orders po
            JOIN plans p ON po.package_id = p.id
            WHERE po.order_id = ? AND po.user_id = ?
        `, [orderId, userId]);

        if (!dbOrder) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // If already completed in our DB, return that
        if (dbOrder.status === 'completed') {
            return res.json({
                status: 'completed',
                payment_id: dbOrder.payment_id,
                created_at: dbOrder.created_at,
                updated_at: dbOrder.updated_at
            });
        }

        // Otherwise, check with Razorpay to see if payment was made
        if (razorpayInstance) {
            try {
                const razorpayOrder = await razorpayInstance.orders.fetch(orderId);
                
                console.log('🔍 Razorpay order fetch result:', {
                    orderId,
                    status: razorpayOrder.status,
                    amount_paid: razorpayOrder.amount_paid
                });
                
                // Test mode auto-complete
                const isTestMode = !process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.startsWith('rzp_test_');
                const shouldAutoComplete = isTestMode && (razorpayOrder.status === 'created' || razorpayOrder.status === 'paid') && (razorpayOrder.amount_paid > 0 || razorpayOrder.attempts >= 1);
                
                if (razorpayOrder.status === 'paid' || razorpayOrder.amount_paid > 0 || shouldAutoComplete) {
                    let paymentId = `test_payment_${orderId}_${Date.now()}`;
                    
                    try {
                        const payments = await razorpayInstance.orders.fetchPayments(orderId);
                        if (payments.items && payments.items.length > 0) {
                            const successfulPayment = payments.items.find(p => p.status === 'captured');
                            if (successfulPayment) {
                                paymentId = successfulPayment.id;
                            }
                        }
                    } catch (paymentFetchError) {
                        console.log('⚠️ Could not fetch payments (test mode), using generated ID');
                    }
                    
                    console.log('✅ Completing payment with ID:', paymentId);
                    
                    // Update our database
                    await dbConfig.run(`
                        UPDATE payment_orders 
                        SET status = 'completed', 
                            payment_id = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE order_id = ? AND user_id = ?
                    `, [paymentId, orderId, userId]);

                    // Add credits to user account
                    await dbConfig.run(`
                        UPDATE users 
                        SET credits = credits + ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `, [dbOrder.credits, userId]);

                    // Create transaction record
                    await dbConfig.run(`
                        INSERT INTO credit_transactions (
                            user_id, transaction_type, credits_change, description, 
                            balance_after, created_at
                        ) VALUES (?, ?, ?, ?, 
                            (SELECT credits FROM users WHERE id = ?),
                            CURRENT_TIMESTAMP
                        )
                    `, [
                        userId,
                        'purchase',
                        dbOrder.credits,
                        `Purchased ${dbOrder.package_name} - Payment ID: ${paymentId}`,
                        userId
                    ]);

                    console.log(`✅ Payment auto-verified for order ${orderId}`);

                    return res.json({
                        status: 'completed',
                        payment_id: paymentId,
                        credits: dbOrder.credits,
                        auto_verified: true
                    });
                }
                
                return res.json({
                    status: razorpayOrder.status === 'paid' ? 'completed' : dbOrder.status,
                    payment_id: dbOrder.payment_id,
                    razorpay_status: razorpayOrder.status
                });

            } catch (razorpayError) {
                console.error('Error fetching from Razorpay:', razorpayError);
                return res.json({
                    status: dbOrder.status,
                    payment_id: dbOrder.payment_id
                });
            }
        }

        res.json({
            status: dbOrder.status,
            payment_id: dbOrder.payment_id,
            created_at: dbOrder.created_at,
            updated_at: dbOrder.updated_at
        });

    } catch (error) {
        console.error('Error fetching payment status:', error);
        res.status(500).json({ error: 'Failed to fetch payment status' });
    }
}

/**
 * Get payment history for user
 */
async function getPaymentHistory(req, res, dbConfig) {
    const userId = req.user.id;

    try {
        const payments = await dbConfig.query(`
            SELECT 
                po.order_id,
                po.payment_id,
                po.amount,
                po.currency,
                po.status,
                po.created_at,
                p.name as package_name,
                p.credits
            FROM payment_orders po
            LEFT JOIN plans p ON po.package_id = p.id
            WHERE po.user_id = $1
            ORDER BY po.created_at DESC
            LIMIT 50
        `, [userId]);

        res.json({ success: true, payments: payments || [] });

    } catch (error) {
        console.error('Error fetching payment history:', error);
        res.status(500).json({ error: 'Failed to fetch payment history' });
    }
}

/**
 * Get Razorpay config (public key only)
 */
function getConfig(req, res) {
    if (!process.env.RAZORPAY_KEY_ID) {
        return res.status(503).json({ 
            error: 'Payment service not configured' 
        });
    }
    
    res.json({
        keyId: process.env.RAZORPAY_KEY_ID
    });
}

// Apple IAP product ID to plan mapping
const APPLE_PRODUCT_TO_PLAN = {
    'com.cvapplyr.mobile.starter': 'Starter',
    'com.cvapplyr.mobile.professional': 'Professional',
    'com.cvapplyr.mobile.premium': 'Premium',
    'com.cvapplyr.mobile.enterprise': 'Enterprise',
};

/**
 * Verify Apple In-App Purchase receipt
 * Supports both StoreKit 2 JWS tokens and legacy base64 receipts
 */
async function verifyApplePurchase(req, res, dbConfig) {
    const { receiptData, productId, transactionId } = req.body;
    const userId = req.user.id || req.user.userId;

    console.log(`🍎 Verifying Apple IAP for User ${userId}, Product: ${productId}, Transaction: ${transactionId}, Receipt length: ${receiptData?.length || 0}`);

    try {
        if (!productId) {
            return res.status(400).json({ error: 'Missing product ID' });
        }
        
        if (!transactionId) {
            return res.status(400).json({ error: 'Missing transaction ID' });
        }

        // Check if this transaction was already processed (prevent duplicate credits)
        const existingTransaction = await dbConfig.get(
            'SELECT id FROM payment_orders WHERE payment_id = ? AND status = ?',
            [transactionId, 'completed']
        );

        if (existingTransaction) {
            console.log('🍎 Transaction already processed:', transactionId);
            const userData = await dbConfig.get(
                'SELECT credits_remaining as credits FROM user_credits WHERE user_id = ?',
                [userId]
            );
            return res.json({
                success: true,
                message: 'Purchase already processed',
                credits: userData?.credits || 0,
                creditsAdded: 0,
                alreadyProcessed: true,
            });
        }

        // ⚠️ SECURITY — this block replaces two forgeable paths that were live in production:
        //   1. "No receipt" trusted `productId` straight out of the request body. That is the branch
        //      StoreKit 2 actually takes, so anyone holding a valid app JWT could POST an arbitrary
        //      product id and mint credits. It is gone.
        //   2. The JWS branch base64-DECODED the client's token and believed the payload. A JWS is
        //      three base64 segments; anybody can write one. Decoding is not verification.
        // Both are now answered by the App Store Server API over TLS with OUR key. If we cannot ask
        // Apple, we grant nothing (503, retryable) — never "assume it's fine".
        const hasReceipt = receiptData && receiptData.length > 0;
        const isJWS = hasReceipt && receiptData.split('.').length === 3;
        console.log(`🍎 Receipt format: ${!hasReceipt ? 'None (StoreKit 2)' : isJWS ? 'StoreKit 2 JWS' : 'Legacy base64'}`);

        // This endpoint sells CONSUMABLE credit packs only. A subscription product arriving here
        // would otherwise be paid for and delivered as credits instead of a plan.
        const storeProducts = require('../services/storeProducts');
        if (storeProducts.isSubscriptionProduct(productId)) {
            return res.status(400).json({ error: 'Use /payment/verify-apple-sub for subscriptions' });
        }

        let verifiedProductId = null;
        let verifiedTransactionId = null;

        const appleApi = require('../services/appleStoreApi');
        if (appleApi.isConfigured()) {
            // AUTHORITATIVE PATH. The client's transactionId is only a pointer; every fact below
            // comes from Apple's own response.
            let tx;
            try {
                tx = await appleApi.getTransactionInfo(transactionId);
            } catch (apiErr) {
                console.error('🍎 App Store Server API unreachable:', apiErr.message);
                return res.status(503).json({ error: 'Could not reach Apple to confirm this purchase', retryable: true });
            }
            if (!tx) {
                console.error('🍎 Apple does not know transaction', transactionId);
                return res.status(400).json({ error: 'Transaction not found at Apple' });
            }
            if (tx.bundleId && tx.bundleId !== (process.env.APPLE_BUNDLE_ID || 'com.cvapplyr.mobile')) {
                return res.status(400).json({ error: 'Invalid bundle ID in transaction' });
            }
            if (tx.productId !== productId) {
                console.error(`🍎 Product mismatch: client said ${productId}, Apple says ${tx.productId}`);
                return res.status(400).json({ error: 'Product ID mismatch' });
            }
            if (tx.revocationDate) {
                return res.status(400).json({ error: 'This purchase was refunded' });
            }
            verifiedProductId = tx.productId;
            verifiedTransactionId = String(tx.transactionId || transactionId);
            console.log(`🍎 Apple-verified: product=${verifiedProductId}, txId=${verifiedTransactionId}, env=${tx._environment}`);
        } else if (!hasReceipt || isJWS) {
            // No server API key and nothing Apple can validate for us → refuse. FAIL CLOSED.
            console.error('🍎 App Store Server API not configured and no verifiable receipt — refusing');
            return res.status(503).json({
                error: 'Purchase verification is temporarily unavailable. Your purchase is safe and will be applied automatically.',
                retryable: true,
            });
        } else {
            // Legacy receipt: Validate with Apple's verifyReceipt endpoint
            let verifyResult = await validateReceiptWithApple(receiptData, false);
            
            if (verifyResult.status === 21007) {
                console.log('🍎 Sandbox receipt detected, retrying with sandbox URL...');
                verifyResult = await validateReceiptWithApple(receiptData, true);
            }

            console.log('🍎 Apple verification status:', verifyResult.status);

            if (verifyResult.status !== 0) {
                console.error('🍎 Apple receipt verification failed, status:', verifyResult.status);
                return res.status(400).json({
                    error: 'Receipt verification failed',
                    appleStatus: verifyResult.status,
                });
            }

            // Find the matching in_app purchase in the receipt
            const inAppPurchases = verifyResult.receipt?.in_app || [];
            const matchingPurchase = inAppPurchases.find(
                (p) => p.product_id === productId && p.transaction_id === transactionId
            );

            if (!matchingPurchase) {
                const latestReceipts = verifyResult.latest_receipt_info || [];
                const latestMatch = latestReceipts.find(
                    (p) => p.product_id === productId && p.transaction_id === transactionId
                );
                if (!latestMatch) {
                    console.error('🍎 Product not found in receipt:', productId);
                    return res.status(400).json({ error: 'Product not found in receipt' });
                }
            }
            
            verifiedProductId = productId;
            verifiedTransactionId = transactionId;
        }

        // Look up the plan from our database using the Apple product ID
        const planName = APPLE_PRODUCT_TO_PLAN[verifiedProductId];
        if (!planName) {
            return res.status(400).json({ error: 'Unknown product ID' });
        }

        const plan = await dbConfig.get(
            'SELECT * FROM plans WHERE name = ? AND is_active = 1',
            [planName]
        );

        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }

        const finalTransactionId = verifiedTransactionId || transactionId;
        console.log(`🍎 Plan found: ${plan.name}, Credits: ${plan.credits}, txId: ${finalTransactionId}`);

        // Record the payment order
        try {
            await dbConfig.run(`
                INSERT INTO payment_orders (
                    order_id, user_id, package_id, plan_id, amount, currency,
                    status, payment_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [
                `apple_${finalTransactionId}`,
                userId,
                plan.id,
                plan.id,
                plan.price,
                'USD',
                'completed',
                finalTransactionId,
            ]);
        } catch (dbError) {
            console.error('🍎 Failed to save order record:', dbError.message);
            // Continue anyway - credits are more important than the order record
        }

        // Add credits to user account
        const existingCredits = await dbConfig.get(
            'SELECT * FROM user_credits WHERE user_id = ?',
            [userId]
        );

        if (!existingCredits) {
            await dbConfig.run(`
                INSERT INTO user_credits (user_id, credits_remaining, credits_total, last_purchase_date)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `, [userId, plan.credits, plan.credits]);
        } else {
            await dbConfig.run(`
                UPDATE user_credits 
                SET credits_remaining = credits_remaining + ?,
                    credits_total = credits_total + ?,
                    last_purchase_date = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ?
            `, [plan.credits, plan.credits, userId]);
        }

        // Create transaction record
        await dbConfig.run(`
            INSERT INTO credit_transactions (
                user_id, transaction_type, credits_change, description,
                balance_after, created_at
            ) VALUES (?, ?, ?, ?,
                (SELECT credits_remaining FROM user_credits WHERE user_id = ?),
                CURRENT_TIMESTAMP
            )
        `, [
            userId,
            'purchase',
            plan.credits,
            `Apple IAP: ${plan.name} - Transaction: ${finalTransactionId}`,
            userId,
        ]);

        // Fetch updated balance
        const userData = await dbConfig.get(
            'SELECT credits_remaining as credits FROM user_credits WHERE user_id = ?',
            [userId]
        );

        console.log('🍎 Credits added successfully! New balance:', userData?.credits);
        try { await notifyCreditsAdded(userId, plan.credits, ((userData?.credits || 0) - plan.credits), (userData?.credits || 0), 'purchase'); } catch (_) {}
        try { require('../services/adminNotifier').notifyNewPurchase(userId, { credits: plan.credits, amount: plan.price, currency: plan.currency || 'USD', plan: plan.name, source: 'Apple IAP' }).catch(() => {}); } catch (_) {}

        res.json({
            success: true,
            message: 'Purchase verified and credits added!',
            credits: userData?.credits || 0,
            creditsAdded: plan.credits,
            packageName: plan.name,
            transactionId: finalTransactionId,
        });

    } catch (error) {
        console.error('🍎 Apple IAP verification error:', error);
        res.status(500).json({
            error: 'Failed to verify Apple purchase',
            message: error.message,
        });
    }
}

/**
 * Validate receipt with Apple's verifyReceipt endpoint
 */
async function validateReceiptWithApple(receiptData, useSandbox) {
    const url = useSandbox
        ? 'https://sandbox.itunes.apple.com/verifyReceipt'
        : 'https://buy.itunes.apple.com/verifyReceipt';

    const body = {
        'receipt-data': receiptData,
        'password': process.env.APPLE_SHARED_SECRET || '',
        'exclude-old-transactions': true,
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    return response.json();
}

module.exports = {
    createOrder,
    verifyPayment,
    verifyApplePurchase,
    getOrderStatus,
    getPaymentHistory,
    getConfig
};
