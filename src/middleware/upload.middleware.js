const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config/env');

const uploadDir = path.join(__dirname, '../../src/uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'application/octet-stream',
  ]);
  const ext = path.extname(file.originalname || '').toLowerCase();
  const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

  const mimeLooksImage = file.mimetype?.startsWith('image/');
  if (mimeLooksImage || allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(ext)) {
    return cb(null, true);
  }

  return cb(new Error('UNSUPPORTED_IMAGE_FORMAT'), false);
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: (config.upload.maxUploadMb || 80) * 1024 * 1024,
    files: 1,
    fieldSize: 2 * 1024 * 1024,
  }
});

module.exports = upload;
