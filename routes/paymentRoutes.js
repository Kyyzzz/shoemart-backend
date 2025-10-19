const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Order = require('../models/Order');

// Generate unique order number
const generateOrderNumber = () => {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ORD-${timestamp}-${randomStr}`;
};

// CREATE PAYMENT INTENT
router.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount',
      });
    }

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'usd',
      automatic_payment_methods: {
        enabled: true,
      },
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error('Payment intent error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment intent',
      error: error.message,
    });
  }
});

// CREATE ORDER
router.post('/create-order', async (req, res) => {
  try {
    const { items, shippingInfo, pricing, paymentIntentId } = req.body;

    // Validate required fields
    if (!items || !shippingInfo || !pricing) {
      return res.status(400).json({
        success: false,
        message: 'Missing required order information',
      });
    }

    // Generate order number
    const orderNumber = generateOrderNumber();

    // Get user ID from token if authenticated
    let userId = null;
    const token = req.headers.authorization?.split(' ')[1];
    
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userId = decoded.id;
      } catch (error) {
        console.log('Token verification failed, creating guest order');
      }
    }

    // IMPORTANT: Check stock availability and update inventory
    const Product = require('../models/product');
    
    for (const item of items) {
      const product = await Product.findById(item.product._id);
      
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product ${item.product.name} not found`,
        });
      }

      // Find the size in the product
      const sizeIndex = product.sizes.findIndex(s => s.size === item.size);
      
      if (sizeIndex === -1) {
        return res.status(400).json({
          success: false,
          message: `Size ${item.size} not available for ${product.name}`,
        });
      }

      // Check if enough stock is available
      if (product.sizes[sizeIndex].stock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name} (Size ${item.size}). Only ${product.sizes[sizeIndex].stock} left.`,
        });
      }

      // Deduct stock
      product.sizes[sizeIndex].stock -= item.quantity;
      
      // Save the updated product
      await product.save();
      
      console.log(`Stock updated for ${product.name} (Size ${item.size}): ${product.sizes[sizeIndex].stock + item.quantity} → ${product.sizes[sizeIndex].stock}`);
    }

    // Create order
    const order = await Order.create({
      orderNumber,
      user: userId,
      items: items.map(item => ({
        product: item.product._id,
        name: item.product.name,
        price: item.product.price,
        size: item.size,
        quantity: item.quantity,
        image: item.product.images[0],
      })),
      shippingInfo,
      pricing,
      paymentInfo: {
        stripePaymentIntentId: paymentIntentId,
        paymentStatus: 'paid',
      },
    });

    console.log('Order created:', {
      orderNumber: order.orderNumber,
      userId: order.user,
      items: order.items.length
    });

    res.status(201).json({
      success: true,
      data: order,
    });
  } catch (error) {
    console.error('Order creation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: error.message,
    });
  }
});

// GET ORDER BY ORDER NUMBER
router.get('/order/:orderNumber', async (req, res) => {
  try {
    const order = await Order.findOne({ 
      orderNumber: req.params.orderNumber 
    }).populate('items.product');

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order',
    });
  }
});

// GET USER ORDERS (requires authentication)
router.get('/my-orders', async (req, res) => {
  try {
    // Get token and verify user
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    console.log('Fetching orders for user:', decoded.id);
    
    const orders = await Order.find({ user: decoded.id })
      .sort({ createdAt: -1 })
      .populate('items.product');

    console.log('Found orders:', orders.length);

    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
      error: error.message,
    });
  }
});

// USER CANCEL OWN ORDER (requires authentication, not admin)
router.patch('/orders/:id/cancel', async (req, res) => {
  try {
    // Verify user is authenticated
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;

    // Find the order
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    // Check if order belongs to this user
    if (order.user.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only cancel your own orders',
      });
    }

    // Check if order is already cancelled
    if (order.orderStatus === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Order is already cancelled',
      });
    }

    // Only allow cancellation of processing orders
    if (order.orderStatus !== 'processing') {
      return res.status(400).json({
        success: false,
        message: 'Only processing orders can be cancelled. Please contact support for assistance.',
      });
    }

    // Restore stock for each item
    const Product = require('../models/product');
    
    for (const item of order.items) {
      const product = await Product.findById(item.product);
      
      if (product) {
        const sizeIndex = product.sizes.findIndex(s => s.size === item.size);
        
        if (sizeIndex !== -1) {
          product.sizes[sizeIndex].stock += item.quantity;
          await product.save();
          
          console.log(`✅ Stock restored: ${product.name} (Size ${item.size}) +${item.quantity} units`);
        }
      }
    }

    // Update order status
    order.orderStatus = 'cancelled';
    order.paymentInfo.paymentStatus = 'refunded';
    await order.save();

    console.log(`📦 Order ${order.orderNumber} cancelled by user and stock restored`);

    res.json({
      success: true,
      message: 'Order cancelled successfully. Stock has been restored and refund will be processed.',
      data: order,
    });
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel order',
      error: error.message,
    });
  }
});

// CANCEL ORDER AND RESTORE STOCK
router.patch('/admin/orders/:id/cancel', async (req, res) => {
  try {
    // Verify admin
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

    const jwt = require('jsonwebtoken');
    const User = require('../models/User');
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user || user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized',
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    if (order.orderStatus === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Order is already cancelled',
      });
    }

    // Only allow cancellation of processing or shipped orders
    if (order.orderStatus === 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel delivered orders. Please process a return instead.',
      });
    }

    // Restore stock for each item
    const Product = require('../models/product');
    
    for (const item of order.items) {
      const product = await Product.findById(item.product);
      
      if (product) {
        const sizeIndex = product.sizes.findIndex(s => s.size === item.size);
        
        if (sizeIndex !== -1) {
          product.sizes[sizeIndex].stock += item.quantity;
          await product.save();
          
          console.log(`✅ Stock restored: ${product.name} (Size ${item.size}) +${item.quantity} units`);
        }
      }
    }

    // Update order status
    order.orderStatus = 'cancelled';
    order.paymentInfo.paymentStatus = 'refunded'; // Mark as refunded
    await order.save();

    console.log(`📦 Order ${order.orderNumber} cancelled and stock restored`);

    res.json({
      success: true,
      message: 'Order cancelled and stock restored successfully',
      data: order,
    });
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel order',
      error: error.message,
    });
  }
});

// GET ALL ORDERS (Admin only)
router.get('/admin/orders', async (req, res) => {
  try {
    // Get token and verify user is admin
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

    const jwt = require('jsonwebtoken');
    const User = require('../models/User');
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user || user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized',
      });
    }

    const orders = await Order.find()
      .sort({ createdAt: -1 })
      .populate('items.product');

    res.json({
      success: true,
      data: orders,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders',
    });
  }
});

// UPDATE ORDER STATUS (Admin only)
router.patch('/admin/orders/:id', async (req, res) => {
  try {
    // Get token and verify user is admin
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

    const jwt = require('jsonwebtoken');
    const User = require('../models/User');
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    
    if (!user || user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized',
      });
    }

    const { orderStatus } = req.body;

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus },
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    res.json({
      success: true,
      data: order,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update order',
      error: error.message,
    });
  }
});

module.exports = router;