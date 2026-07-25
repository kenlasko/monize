const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', '.env');
const examplePath = path.join(__dirname, '..', '.env.example');

if (fs.existsSync(envPath)) {
  console.log('.env file already exists. Skipping generation.');
  process.exit(0);
}

if (!fs.existsSync(examplePath)) {
  console.error('.env.example not found at ' + examplePath);
  process.exit(1);
}

console.log('Generating .env file from .env.example...');
let content = fs.readFileSync(examplePath, 'utf8');

// Generate secure keys
const jwtSecret = crypto.randomBytes(32).toString('base64');
const aiEncryptionKey = crypto.randomBytes(32).toString('hex');
const postgresPassword = crypto.randomBytes(16).toString('hex');

// Perform replacements robustly using regex
content = content.replace(
  /JWT_SECRET=your-super-secret-jwt-key-change-in-production/g,
  `JWT_SECRET=${jwtSecret}`
);
content = content.replace(
  /POSTGRES_PASSWORD=changeme_in_production/g,
  `POSTGRES_PASSWORD=${postgresPassword}`
);

// Map frontend to port 3005 to avoid local conflicts on 3001
content = content.replace(/FRONTEND_PORT=3001/g, 'FRONTEND_PORT=3005');
content = content.replace(/PUBLIC_APP_URL=http:\/\/localhost:3001/g, 'PUBLIC_APP_URL=http://localhost:3005');
content = content.replace(/CORS_ORIGIN=http:\/\/localhost:3001/g, 'CORS_ORIGIN=http://localhost:3005');

// Match commented or uncommented AI_ENCRYPTION_KEY lines and replace them
if (/#?\s*AI_ENCRYPTION_KEY=/.test(content)) {
  content = content.replace(
    /#?\s*AI_ENCRYPTION_KEY=.*/g,
    `AI_ENCRYPTION_KEY=${aiEncryptionKey}`
  );
} else {
  // If not found, append it
  content += `\nAI_ENCRYPTION_KEY=${aiEncryptionKey}\n`;
}

fs.writeFileSync(envPath, content, 'utf8');
console.log('.env file successfully created with secure generated secrets!');
