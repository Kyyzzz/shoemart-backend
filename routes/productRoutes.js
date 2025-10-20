const express = require('express');
const router = express.Router();
const Product = require('../models/product');

// Escape user input before using inside a RegExp pattern
function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// SEARCH PRODUCTS (add this BEFORE the GET all products route)
router.get('/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;

    if (!q || q.trim() === '') {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Search by name, brand, or category
    const searchRegex = new RegExp(q, 'i'); // case-insensitive

    const products = await Product.find({
      $or: [
        { name: searchRegex },
        { brand: searchRegex },
        { category: searchRegex },
        { description: searchRegex },
      ],
    })
      .limit(parseInt(limit))
      .select('name brand category price images averageRating');

    res.json({
      success: true,
      count: products.length,
      data: products,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Search failed',
      error: error.message,
    });
  }
});

// GET all products with filters
router.get('/', async (req, res) => {
  try {
    const { brand, category, minPrice, maxPrice, size, search } = req.query;
    
    // Build filter object dynamically
    let filter = {};
    let andConditions = [];
    
    // Add search filter if provided (check for non-empty string)
    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search, 'i');
      andConditions.push({
        $or: [
          { name: searchRegex },
          { brand: searchRegex },
          { category: searchRegex },
          { description: searchRegex },
        ]
      });
    }
    
    if (brand) {
      andConditions.push({ brand: brand });
    }
    if (category) {
      andConditions.push({ category: category });
    }
    if (minPrice || maxPrice) {
      const priceFilter = {};
      if (minPrice) priceFilter.$gte = Number(minPrice);
      if (maxPrice) priceFilter.$lte = Number(maxPrice);
      andConditions.push({ price: priceFilter });
    }
    if (size) {
      andConditions.push({ 'sizes.size': Number(size) });
    }

    // Combine all conditions with $and if there are any
    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    const products = await Product.find(filter);
    
    res.json({
      success: true,
      count: products.length,
      data: products,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server Error',
      error: error.message,
    });
  }
});

// GET featured products
router.get('/featured', async (req, res) => {
  try {
    const products = await Product.find({ featured: true }).limit(6);
    res.json({
      success: true,
      data: products
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server Error'
    });
  }
});

// GET single product by ID
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server Error'
    });
  }
});

// POST create new product (Admin only - we'll add auth later)
router.post('/', async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json({
      success: true,
      data: product
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Invalid product data',
      error: error.message
    });
  }
});

// PUT update product
router.put('/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Update failed',
      error: error.message
    });
  }
});

// DELETE product
router.delete('/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Delete failed'
    });
  }
});

module.exports = router;