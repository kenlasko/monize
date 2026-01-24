#!/bin/bash

# MoneyMate Application Setup Script
# This script sets up the complete environment for testing

set -e  # Exit on any error

echo "=========================================="
echo "MoneyMate Application Setup"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Check PostgreSQL
echo -e "${BLUE}Step 1: Checking PostgreSQL...${NC}"
if command -v psql &> /dev/null; then
    echo -e "${GREEN}✓ PostgreSQL is installed${NC}"
    psql --version
else
    echo -e "${RED}✗ PostgreSQL is not installed${NC}"
    exit 1
fi

# Step 2: Start PostgreSQL (WSL specific)
echo ""
echo -e "${BLUE}Step 2: Starting PostgreSQL...${NC}"
sudo service postgresql start || sudo systemctl start postgresql || echo "PostgreSQL may already be running"
sleep 2

# Step 3: Create database and user
echo ""
echo -e "${BLUE}Step 3: Setting up database...${NC}"
sudo -u postgres psql <<EOF
-- Create database if it doesn't exist
SELECT 'CREATE DATABASE moneymate' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'moneymate')\gexec

-- Create user if it doesn't exist
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'moneymate_user') THEN
    CREATE USER moneymate_user WITH PASSWORD 'moneymate_password';
  END IF;
END
\$\$;

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE moneymate TO moneymate_user;
ALTER DATABASE moneymate OWNER TO moneymate_user;

\c moneymate
GRANT ALL ON SCHEMA public TO moneymate_user;
EOF

echo -e "${GREEN}✓ Database and user created${NC}"

# Step 4: Run database migrations
echo ""
echo -e "${BLUE}Step 4: Running database migrations...${NC}"
cd /home/ken/moneymate

# Run initial migration
if [ -f "database/migrations/001_initial_schema.sql" ]; then
    echo "Running 001_initial_schema.sql..."
    sudo -u postgres psql -d moneymate -f database/migrations/001_initial_schema.sql
    echo -e "${GREEN}✓ Initial schema created${NC}"
fi

# Run category migration
if [ -f "database/migrations/002_add_category_to_transactions.sql" ]; then
    echo "Running 002_add_category_to_transactions.sql..."
    sudo -u postgres psql -d moneymate -f database/migrations/002_add_category_to_transactions.sql
    echo -e "${GREEN}✓ Category support added${NC}"
fi

# Step 5: Install backend dependencies
echo ""
echo -e "${BLUE}Step 5: Installing backend dependencies...${NC}"
cd /home/ken/moneymate/backend
if [ ! -d "node_modules" ]; then
    npm install
    echo -e "${GREEN}✓ Backend dependencies installed${NC}"
else
    echo -e "${GREEN}✓ Backend dependencies already installed${NC}"
fi

# Step 6: Configure backend environment
echo ""
echo -e "${BLUE}Step 6: Configuring backend environment...${NC}"
if [ ! -f ".env" ]; then
    cat > .env <<EOF
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=moneymate_user
DB_PASSWORD=moneymate_password
DB_DATABASE=moneymate

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=7d

# App Configuration
PORT=3000
NODE_ENV=development

# Google OAuth (optional - for testing can be left empty)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback

# Frontend URL
FRONTEND_URL=http://localhost:3001
EOF
    echo -e "${GREEN}✓ Backend .env file created${NC}"
else
    echo -e "${GREEN}✓ Backend .env file already exists${NC}"
fi

# Step 7: Install frontend dependencies
echo ""
echo -e "${BLUE}Step 7: Installing frontend dependencies...${NC}"
cd /home/ken/moneymate/frontend
if [ ! -d "node_modules" ]; then
    npm install
    echo -e "${GREEN}✓ Frontend dependencies installed${NC}"
else
    echo -e "${GREEN}✓ Frontend dependencies already installed${NC}"
fi

# Step 8: Configure frontend environment
echo ""
echo -e "${BLUE}Step 8: Configuring frontend environment...${NC}"
if [ ! -f ".env.local" ]; then
    cat > .env.local <<EOF
NEXT_PUBLIC_API_URL=http://localhost:3000
EOF
    echo -e "${GREEN}✓ Frontend .env.local file created${NC}"
else
    echo -e "${GREEN}✓ Frontend .env.local file already exists${NC}"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "Setup Complete!"
echo "==========================================${NC}"
echo ""
echo "Next steps:"
echo ""
echo "1. Start the backend server:"
echo "   cd /home/ken/moneymate/backend"
echo "   npm run start:dev"
echo ""
echo "2. In a new terminal, start the frontend:"
echo "   cd /home/ken/moneymate/frontend"
echo "   npm run dev"
echo ""
echo "3. Open your browser to: http://localhost:3001"
echo ""
echo "4. Register a new account and start testing!"
echo ""
