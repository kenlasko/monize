#!/bin/bash

# MoneyMate Docker Setup Script
# Sets up and runs the entire application in Docker containers

set -e  # Exit on any error

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=========================================="
echo "MoneyMate Docker Setup"
echo -e "==========================================${NC}"
echo ""

# Step 1: Check Docker
echo -e "${BLUE}Step 1: Checking Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}✗ Docker is not installed${NC}"
    echo "Please install Docker Desktop or Docker Engine first"
    exit 1
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null 2>&1; then
    echo -e "${RED}✗ Docker Compose is not installed${NC}"
    echo "Please install Docker Compose first"
    exit 1
fi

echo -e "${GREEN}✓ Docker is installed${NC}"
docker --version
echo -e "${GREEN}✓ Docker Compose is installed${NC}"
docker compose version 2>/dev/null || docker-compose --version

# Step 2: Check if Docker daemon is running
echo ""
echo -e "${BLUE}Step 2: Checking Docker daemon...${NC}"
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}✗ Docker daemon is not running${NC}"
    echo "Please start Docker Desktop or Docker daemon first"
    exit 1
fi
echo -e "${GREEN}✓ Docker daemon is running${NC}"

# Step 3: Copy environment file
echo ""
echo -e "${BLUE}Step 3: Setting up environment...${NC}"
if [ ! -f ".env" ]; then
    cp .env.docker .env
    echo -e "${GREEN}✓ Created .env file from .env.docker${NC}"
else
    echo -e "${YELLOW}⚠ .env file already exists, skipping${NC}"
fi

# Step 4: Stop any existing containers
echo ""
echo -e "${BLUE}Step 4: Cleaning up old containers...${NC}"
docker compose down 2>/dev/null || docker-compose down 2>/dev/null || true
echo -e "${GREEN}✓ Old containers stopped${NC}"

# Step 5: Build Docker images
echo ""
echo -e "${BLUE}Step 5: Building Docker images...${NC}"
echo "This may take a few minutes on first run..."
if command -v docker &> /dev/null && docker compose version &> /dev/null 2>&1; then
    docker compose build
else
    docker-compose build
fi
echo -e "${GREEN}✓ Docker images built${NC}"

# Step 6: Start containers
echo ""
echo -e "${BLUE}Step 6: Starting containers...${NC}"
if command -v docker &> /dev/null && docker compose version &> /dev/null 2>&1; then
    docker compose up -d
else
    docker-compose up -d
fi

echo ""
echo -e "${BLUE}Waiting for services to be healthy...${NC}"
sleep 5

# Check if containers are running
if docker ps | grep -q "moneymate-postgres"; then
    echo -e "${GREEN}✓ PostgreSQL is running${NC}"
else
    echo -e "${RED}✗ PostgreSQL failed to start${NC}"
    docker logs moneymate-postgres
    exit 1
fi

if docker ps | grep -q "moneymate-backend"; then
    echo -e "${GREEN}✓ Backend is running${NC}"
else
    echo -e "${YELLOW}⚠ Backend may still be starting...${NC}"
fi

if docker ps | grep -q "moneymate-frontend"; then
    echo -e "${GREEN}✓ Frontend is running${NC}"
else
    echo -e "${YELLOW}⚠ Frontend may still be starting...${NC}"
fi

echo ""
echo -e "${GREEN}=========================================="
echo "Setup Complete!"
echo -e "==========================================${NC}"
echo ""
echo -e "${BLUE}Services:${NC}"
echo "  🗄️  PostgreSQL: localhost:5432"
echo "  🚀 Backend API: http://localhost:3000"
echo "  🌐 Frontend:    http://localhost:3001"
echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo ""
echo "1. Wait 30-60 seconds for all services to fully start"
echo ""
echo "2. Open your browser to: ${GREEN}http://localhost:3001${NC}"
echo ""
echo "3. Register a new account (click 'Sign Up')"
echo ""
echo "4. Create sample data with:"
echo "   ${YELLOW}./create-sample-data-docker.sh${NC}"
echo ""
echo -e "${BLUE}Useful Commands:${NC}"
echo ""
echo "View logs:"
echo "  docker compose logs -f               # All services"
echo "  docker compose logs -f backend       # Backend only"
echo "  docker compose logs -f frontend      # Frontend only"
echo ""
echo "Stop all services:"
echo "  docker compose down"
echo ""
echo "Restart services:"
echo "  docker compose restart"
echo ""
echo "View API documentation:"
echo "  ${GREEN}http://localhost:3000/api${NC}"
echo ""
echo -e "${GREEN}Happy testing! 🎉${NC}"
echo ""
