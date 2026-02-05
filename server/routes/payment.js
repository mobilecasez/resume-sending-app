const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const paymentController = require('../controllers/paymentController');

// Pass dbConfig through middleware
let dbConfig;

function setDbConfig(db) {
    dbConfig = db;
}

// Create Razorpay order
router.post('/create-order', authenticateToken, (req, res) => {
    paymentController.createOrder(req, res, dbConfig);
});

// Verify Razorpay payment
router.post('/verify', authenticateToken, (req, res) => {
    paymentController.verifyPayment(req, res, dbConfig);
});

// Get payment order status
router.get('/status/:orderId', authenticateToken, (req, res) => {
    paymentController.getOrderStatus(req, res, dbConfig);
});

// Get payment history
router.get('/history', authenticateToken, (req, res) => {
    paymentController.getPaymentHistory(req, res, dbConfig);
});

// Get Razorpay config
router.get('/config', (req, res) => {
    paymentController.getConfig(req, res);
});

module.exports = { router, setDbConfig };
