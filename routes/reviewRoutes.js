const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Review = require('../models/Review');
const Product = require('../models/product');
const Order = require('../models/Order');
const User = require('../models/User');

// Middleware to verify user authentication
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated',
      });
    }

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

// Helper function to update product rating
const updateProductRating = async (productId) => {
  const reviews = await Review.find({ product: productId });
  
  if (reviews.length === 0) {
    await Product.findByIdAndUpdate(productId, {
      averageRating: 0,
      totalReviews: 0,
    });
    return;
  }

  const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
  const averageRating = totalRating / reviews.length;

  await Product.findByIdAndUpdate(productId, {
    averageRating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
    totalReviews: reviews.length,
  });
};

// GET reviews for a product
router.get('/product/:productId', async (req, res) => {
  try {
    const reviews = await Review.find({ product: req.params.productId })
      .populate('user', 'name')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: reviews,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reviews',
    });
  }
});

// CHECK if user can review (has purchased the product)
router.get('/can-review/:productId', authenticate, async (req, res) => {
  try {
    // Check if user already reviewed this product
    const existingReview = await Review.findOne({
      product: req.params.productId,
      user: req.userId,
    });

    if (existingReview) {
      return res.json({
        success: true,
        canReview: false,
        reason: 'already_reviewed',
        existingReview,
      });
    }

    // Check if user has purchased this product
    const hasPurchased = await Order.findOne({
      user: req.userId,
      'items.product': req.params.productId,
      orderStatus: { $in: ['delivered', 'processing', 'shipped'] },
    });

    res.json({
      success: true,
      canReview: !!hasPurchased,
      reason: hasPurchased ? 'can_review' : 'no_purchase',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to check review eligibility',
    });
  }
});

// CREATE a review
router.post('/', authenticate, async (req, res) => {
  try {
    const { productId, rating, title, comment } = req.body;

    // Validate input
    if (!productId || !rating || !title || !comment) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields',
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5',
      });
    }

    // Check if product exists
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }

    // Check if user already reviewed
    const existingReview = await Review.findOne({
      product: productId,
      user: req.userId,
    });

    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this product',
      });
    }

    // Check if user purchased the product (for verified badge)
    const order = await Order.findOne({
      user: req.userId,
      'items.product': productId,
      'paymentInfo.paymentStatus': 'paid',
    });

    // Create review
    const review = await Review.create({
      product: productId,
      user: req.userId,
      order: order?._id,
      rating,
      title,
      comment,
      isVerifiedPurchase: !!order,
    });

    // Update product rating
    await updateProductRating(productId);

    // Populate user data
    await review.populate('user', 'name');

    res.status(201).json({
      success: true,
      message: 'Review created successfully',
      data: review,
    });
  } catch (error) {
    console.error('Error creating review:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create review',
      error: error.message,
    });
  }
});

// UPDATE a review
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { rating, title, comment } = req.body;

    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found',
      });
    }

    // Check if user owns this review
    if (review.user.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only edit your own reviews',
      });
    }

    // Update review
    review.rating = rating || review.rating;
    review.title = title || review.title;
    review.comment = comment || review.comment;

    await review.save();

    // Update product rating
    await updateProductRating(review.product);

    await review.populate('user', 'name');

    res.json({
      success: true,
      message: 'Review updated successfully',
      data: review,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update review',
    });
  }
});

// DELETE a review
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found',
      });
    }

    // Check if user owns this review
    if (review.user.toString() !== req.userId) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own reviews',
      });
    }

    const productId = review.product;
    await Review.findByIdAndDelete(req.params.id);

    // Update product rating
    await updateProductRating(productId);

    res.json({
      success: true,
      message: 'Review deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete review',
    });
  }
});

// MARK REVIEW AS HELPFUL (with user tracking)
router.patch('/:id/helpful', async (req, res) => {
    try {
      // Check if user is authenticated (optional - you can allow guests)
      const token = req.headers.authorization?.split(' ')[1];
      let userId = null;
  
      if (token) {
        try {
          const jwt = require('jsonwebtoken');
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          userId = decoded.id;
        } catch (error) {
          // Token invalid, continue as guest
        }
      }
  
      // If no userId, we can either:
      // Option 1: Require login
      // Option 2: Allow but don't track (current implementation)
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Please login to mark reviews as helpful',
        });
      }
  
      const review = await Review.findById(req.params.id);
  
      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found',
        });
      }
  
      // Check if user already marked this as helpful
      const alreadyMarked = review.helpfulBy.includes(userId);
  
      if (alreadyMarked) {
        // Remove the helpful vote (toggle off)
        review.helpfulBy = review.helpfulBy.filter(
          (id) => id.toString() !== userId
        );
        review.helpful = Math.max(0, review.helpful - 1);
      } else {
        // Add the helpful vote
        review.helpfulBy.push(userId);
        review.helpful += 1;
      }
  
      await review.save();
  
      res.json({
        success: true,
        data: {
          helpful: review.helpful,
          userMarkedHelpful: !alreadyMarked,
        },
      });
    } catch (error) {
      console.error('Error marking review as helpful:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to mark review as helpful',
      });
    }
  });
  
  // GET if user marked review as helpful
  router.get('/:id/helpful-status', async (req, res) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      
      if (!token) {
        return res.json({
          success: true,
          userMarkedHelpful: false,
        });
      }
  
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.id;
  
      const review = await Review.findById(req.params.id);
  
      if (!review) {
        return res.status(404).json({
          success: false,
          message: 'Review not found',
        });
      }
  
      const userMarkedHelpful = review.helpfulBy.includes(userId);
  
      res.json({
        success: true,
        userMarkedHelpful,
      });
    } catch (error) {
      res.json({
        success: true,
        userMarkedHelpful: false,
      });
    }
  });

module.exports = router;