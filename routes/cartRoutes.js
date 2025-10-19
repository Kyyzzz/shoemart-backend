const express = require('express');
const router = express.Router();
const Cart = require('../models/Cart');
const jwt = require('jsonwebtoken');

// Middleware to verify token
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authenticated',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }
};

// GET user cart
router.get('/', authenticate, async (req, res) => {
  try {
    let cart = await Cart.findOne({ user: req.userId }).populate('items.product');
    
    if (!cart) {
      cart = await Cart.create({ user: req.userId, items: [] });
    }

    res.json({
      success: true,
      data: cart.items,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch cart',
    });
  }
});

// ADD item to cart
router.post('/add', authenticate, async (req, res) => {
  try {
    const { productId, size, quantity } = req.body;

    let cart = await Cart.findOne({ user: req.userId });

    if (!cart) {
      cart = await Cart.create({ user: req.userId, items: [] });
    }

    // Check if item already exists
    const existingItemIndex = cart.items.findIndex(
      (item) => item.product.toString() === productId && item.size === size
    );

    if (existingItemIndex > -1) {
      // Update quantity
      cart.items[existingItemIndex].quantity += quantity;
    } else {
      // Add new item
      cart.items.push({ product: productId, size, quantity });
    }

    await cart.save();
    await cart.populate('items.product');

    res.json({
      success: true,
      data: cart.items,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to add to cart',
    });
  }
});

// UPDATE item quantity
router.put('/update', authenticate, async (req, res) => {
  try {
    const { productId, size, quantity } = req.body;

    const cart = await Cart.findOne({ user: req.userId });

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: 'Cart not found',
      });
    }

    const itemIndex = cart.items.findIndex(
      (item) => item.product.toString() === productId && item.size === size
    );

    if (itemIndex > -1) {
      if (quantity <= 0) {
        // Remove item
        cart.items.splice(itemIndex, 1);
      } else {
        // Update quantity
        cart.items[itemIndex].quantity = quantity;
      }

      await cart.save();
      await cart.populate('items.product');
    }

    res.json({
      success: true,
      data: cart.items,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update cart',
    });
  }
});

// REMOVE item from cart
router.delete('/remove', authenticate, async (req, res) => {
  try {
    const { productId, size } = req.body;

    const cart = await Cart.findOne({ user: req.userId });

    if (!cart) {
      return res.status(404).json({
        success: false,
        message: 'Cart not found',
      });
    }

    cart.items = cart.items.filter(
      (item) => !(item.product.toString() === productId && item.size === size)
    );

    await cart.save();
    await cart.populate('items.product');

    res.json({
      success: true,
      data: cart.items,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to remove from cart',
    });
  }
});

// CLEAR cart
router.delete('/clear', authenticate, async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.userId });

    if (cart) {
      cart.items = [];
      await cart.save();
    }

    res.json({
      success: true,
      data: [],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to clear cart',
    });
  }
});

module.exports = router;