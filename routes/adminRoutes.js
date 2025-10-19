const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Product = require('../models/product');
const Order = require('../models/Order');

// Middleware to verify admin
const verifyAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }
};

// GET DASHBOARD STATS
router.get('/stats', verifyAdmin, async (req, res) => {
  try {
    // Get total products
    const totalProducts = await Product.countDocuments();

    // Get total orders
    const totalOrders = await Order.countDocuments();

    // Get total users
    const totalUsers = await User.countDocuments();

    // Calculate total revenue
    const revenueData = await Order.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: '$pricing.total' },
        },
      },
    ]);
    const totalRevenue = revenueData.length > 0 ? revenueData[0].total : 0;

    // Get stats from 30 days ago for comparison
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Products added in last 30 days
    const recentProducts = await Product.countDocuments({
      createdAt: { $gte: thirtyDaysAgo },
    });

    // Orders in last 30 days
    const recentOrders = await Order.countDocuments({
      createdAt: { $gte: thirtyDaysAgo },
    });

    // Users registered in last 30 days
    const recentUsers = await User.countDocuments({
      createdAt: { $gte: thirtyDaysAgo },
    });

    // Revenue in last 30 days
    const recentRevenueData = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$pricing.total' },
        },
      },
    ]);
    const recentRevenue = recentRevenueData.length > 0 ? recentRevenueData[0].total : 0;

    // Calculate percentage changes
    const calculateChange = (recent, total) => {
      if (total === 0) return 0;
      const old = total - recent;
      if (old === 0) return 100;
      return ((recent / old) * 100).toFixed(1);
    };

    res.json({
      success: true,
      data: {
        products: {
          total: totalProducts,
          change: `+${calculateChange(recentProducts, totalProducts)}%`,
        },
        orders: {
          total: totalOrders,
          change: `+${calculateChange(recentOrders, totalOrders)}%`,
        },
        users: {
          total: totalUsers,
          change: `+${calculateChange(recentUsers, totalUsers)}%`,
        },
        revenue: {
          total: totalRevenue,
          change: `+${calculateChange(recentRevenue, totalRevenue)}%`,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch stats',
      error: error.message,
    });
  }
});

// GET RECENT ACTIVITY
router.get('/recent-activity', verifyAdmin, async (req, res) => {
  try {
    const activities = [];

    // Get recent orders (last 10)
    const recentOrders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('orderNumber pricing.total createdAt shippingInfo');

    recentOrders.forEach((order) => {
      activities.push({
        type: 'order',
        title: 'New order received',
        description: `Order #${order.orderNumber} - $${order.pricing.total.toFixed(2)}`,
        time: order.createdAt,
      });
    });

    // Get recently added products (last 5)
    const recentProducts = await Product.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name createdAt');

    recentProducts.forEach((product) => {
      activities.push({
        type: 'product',
        title: 'Product added',
        description: product.name,
        time: product.createdAt,
      });
    });

    // Get recently registered users (last 5)
    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('email createdAt');

    recentUsers.forEach((user) => {
      activities.push({
        type: 'user',
        title: 'New user registered',
        description: user.email,
        time: user.createdAt,
      });
    });

    // Sort all activities by time
    activities.sort((a, b) => new Date(b.time) - new Date(a.time));

    // Return top 10 most recent
    res.json({
      success: true,
      data: activities.slice(0, 10),
    });
  } catch (error) {
    console.error('Error fetching recent activity:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent activity',
      error: error.message,
    });
  }
});

// GET REVENUE CHART DATA (Last 7 days)
router.get('/revenue-chart', verifyAdmin, async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const revenueByDay = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: sevenDaysAgo },
          'paymentInfo.paymentStatus': 'paid',
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          revenue: { $sum: '$pricing.total' },
          orders: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ]);

    res.json({
      success: true,
      data: revenueByDay,
    });
  } catch (error) {
    console.error('Error fetching revenue chart:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch revenue chart',
      error: error.message,
    });
  }
});

// GET TOP SELLING PRODUCTS
router.get('/top-products', verifyAdmin, async (req, res) => {
  try {
    const topProducts = await Order.aggregate([
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          totalSold: { $sum: '$items.quantity' },
          revenue: {
            $sum: { $multiply: ['$items.price', '$items.quantity'] },
          },
        },
      },
      { $sort: { totalSold: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: '$product' },
    ]);

    res.json({
      success: true,
      data: topProducts,
    });
  } catch (error) {
    console.error('Error fetching top products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch top products',
      error: error.message,
    });
  }
});

module.exports = router;