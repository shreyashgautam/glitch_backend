require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const routes = require('./routes/index');
const whatsappRoute = require('./routes/whatsapp');

function createApp(io) {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use((req, res, next) => {
    req.io = io || null;
    next();
  });

  app.use('/api', routes);
  app.use('/api/whatsapp', whatsappRoute);

  app.get('/', (req, res) =>
    res.json({
      status: 'Patient Intelligence Backend Running',
      hospital: 'Kathir Memorial Hospital',
    })
  );

  return app;
}

module.exports = { createApp };
