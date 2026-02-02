#!/bin/bash

# Personal Finance Management System - Quick Start Script

set -e

echo "🚀 Personal Finance Management System - Quick Start"
echo "=================================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first:"
    echo "   https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first:"
    echo "   https://docs.docker.com/compose/install/"
    exit 1
fi

# Check if .env file exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env

    # Generate random secrets
    JWT_SECRET=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
    SESSION_SECRET=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
    POSTGRES_PASSWORD=$(openssl rand -base64 16 2>/dev/null || head -c 16 /dev/urandom | base64)

    # Update .env with generated secrets
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s|JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|g" .env
        sed -i '' "s|SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|g" .env
        sed -i '' "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|g" .env
    else
        # Linux
        sed -i "s|JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|g" .env
        sed -i "s|SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|g" .env
        sed -i "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|g" .env
    fi

    echo "✅ .env file created with secure random secrets"
    echo ""
    echo "⚠️  IMPORTANT: Please edit .env and add your API keys:"
    echo "   - EXCHANGE_RATE_API_KEY (get from https://exchangerate-api.com)"
    echo "   - STOCK_API_KEY (get from https://www.alphavantage.co)"
    echo ""
    read -p "Press Enter to continue or Ctrl+C to exit and edit .env first..."
fi

echo ""
echo "🐳 Starting Docker containers..."
echo ""

# Start Docker Compose
if command -v docker-compose &> /dev/null; then
    docker-compose up -d
else
    docker compose up -d
fi

echo ""
echo "⏳ Waiting for services to be ready..."
echo ""

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL..."
for i in {1..30}; do
    if docker-compose exec -T postgres pg_isready -U moneymate_user -d moneymate_db &> /dev/null || \
       docker compose exec -T postgres pg_isready -U moneymate_user -d moneymate_db &> /dev/null; then
        echo "✅ PostgreSQL is ready"
        break
    fi
    echo -n "."
    sleep 2
done

echo ""

# Wait for backend to be ready
echo "Waiting for backend API..."
for i in {1..30}; do
    if curl -s http://localhost:3001/api/v1/auth/profile &> /dev/null; then
        echo "✅ Backend API is ready"
        break
    fi
    echo -n "."
    sleep 2
done

echo ""
echo "✅ All services are up and running!"
echo ""
echo "=================================================="
echo "🎉 Your Personal Finance Management System is ready!"
echo "=================================================="
echo ""
echo "📱 Access the application:"
echo "   Frontend:          http://localhost:3000"
echo "   Backend API:       http://localhost:3001"
echo "   API Documentation: http://localhost:3001/api/docs"
echo ""
echo "🔧 Useful commands:"
echo "   View logs:         docker-compose logs -f"
echo "   Stop services:     docker-compose down"
echo "   Restart:           docker-compose restart"
echo ""
echo "📚 Documentation:"
echo "   README.md              - Project overview"
echo "   GETTING_STARTED.md     - Detailed setup guide"
echo "   IMPLEMENTATION_GUIDE.md - Development roadmap"
echo ""
echo "🔐 Default credentials:"
echo "   Create a new account at http://localhost:3000"
echo ""
echo "Happy budgeting! 💰"
