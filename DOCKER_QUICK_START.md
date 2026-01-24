# MoneyMate - Docker Quick Start 🐳

Get MoneyMate running in Docker containers with a single command!

## Prerequisites

- **Docker**: Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (includes Docker Compose)
  - Windows/Mac: Docker Desktop
  - Linux: Docker Engine + Docker Compose plugin

## Quick Setup (One Command!)

```bash
cd /home/ken/moneymate
chmod +x docker-setup.sh create-sample-data-docker.sh
./docker-setup.sh
```

That's it! The script will:
- ✅ Verify Docker is installed and running
- ✅ Create environment configuration
- ✅ Build Docker images
- ✅ Start all services (PostgreSQL, Backend, Frontend)
- ✅ Initialize the database with migrations

## What Gets Started

After running the setup script, you'll have:

| Service | URL | Container Name |
|---------|-----|----------------|
| Frontend (Next.js) | http://localhost:3001 | moneymate-frontend |
| Backend API (NestJS) | http://localhost:3000 | moneymate-backend |
| PostgreSQL Database | localhost:5432 | moneymate-postgres |
| Redis Cache | localhost:6379 | moneymate-redis |

## Create Your Account & Test

### 1. Register a User

Open your browser to: **http://localhost:3001**

- Click "Sign Up"
- Fill in your details (email, password, name)
- Click "Create Account"

### 2. Login

Use your newly created credentials to login

### 3. Create Sample Data

Run the sample data script:

```bash
cd /home/ken/moneymate
./create-sample-data-docker.sh
```

Enter your email and password when prompted. This creates:
- 7 Categories (Groceries, Utilities, Entertainment, etc.)
- 3 Accounts (Checking, Savings, Credit Card)
- 6 Payees with default categories
- 6 Sample Transactions

### 4. Explore the UI

Navigate to the Transactions page and test:
- ✅ Payee autocomplete
- ✅ Auto category assignment
- ✅ Transaction filtering
- ✅ Summary calculations
- ✅ Edit/Delete operations

## Docker Commands

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

### Stop Services

```bash
docker compose down
```

### Start Services (after stopping)

```bash
docker compose up -d
```

### Restart a Service

```bash
# Restart backend only
docker compose restart backend

# Restart all
docker compose restart
```

### Rebuild Images (after code changes)

```bash
docker compose down
docker compose build
docker compose up -d
```

### View Running Containers

```bash
docker compose ps
```

### Access Container Shell

```bash
# Backend container
docker exec -it moneymate-backend sh

# Database
docker exec -it moneymate-postgres psql -U moneymate_user -d moneymate
```

### Remove Everything (including volumes)

```bash
docker compose down -v
```

**⚠️ Warning**: This deletes all data including the database!

## Environment Configuration

The setup script creates a `.env` file from `.env.docker`. You can customize:

- `POSTGRES_DB` - Database name (default: moneymate)
- `POSTGRES_USER` - Database user (default: moneymate_user)
- `POSTGRES_PASSWORD` - Database password (default: moneymate_password)
- `BACKEND_PORT` - Backend port (default: 3000)
- `FRONTEND_PORT` - Frontend port (default: 3001)
- `JWT_SECRET` - JWT signing secret
- `GOOGLE_CLIENT_ID` - Google OAuth (optional)
- `GOOGLE_CLIENT_SECRET` - Google OAuth (optional)

## Troubleshooting

### Port Already in Use

If ports 3000 or 3001 are already taken:

1. Edit `.env` file
2. Change `BACKEND_PORT` or `FRONTEND_PORT`
3. Restart: `docker compose down && docker compose up -d`

### Services Won't Start

Check logs:
```bash
docker compose logs backend
docker compose logs frontend
docker compose logs postgres
```

### Database Connection Issues

Verify PostgreSQL is healthy:
```bash
docker compose ps
```

Should show "healthy" status for postgres.

### Frontend Can't Connect to Backend

1. Check backend is running: `docker compose ps`
2. Check backend logs: `docker compose logs backend`
3. Verify `NEXT_PUBLIC_API_URL` in `.env` matches backend port

### Permission Errors on Linux

If you get permission errors:
```bash
sudo usermod -aG docker $USER
```

Then logout and login again.

### Clean Start

If things are broken, start fresh:
```bash
# Remove everything
docker compose down -v

# Remove images
docker compose down --rmi all

# Run setup again
./docker-setup.sh
```

## Development Workflow

### Hot Reload

Both backend and frontend support hot reload:
- Edit files in `./backend/src` - Backend auto-restarts
- Edit files in `./frontend/src` - Frontend auto-reloads

### Installing New Dependencies

If you add packages to `package.json`:

**Backend:**
```bash
docker compose exec backend npm install
docker compose restart backend
```

**Frontend:**
```bash
docker compose exec frontend npm install
docker compose restart frontend
```

Or rebuild:
```bash
docker compose down
docker compose build backend frontend
docker compose up -d
```

## API Documentation

Once backend is running, view Swagger docs:

**http://localhost:3000/api**

## Database Access

### Using psql

```bash
docker exec -it moneymate-postgres psql -U moneymate_user -d moneymate
```

### Using a GUI Tool

Connect with your favorite PostgreSQL client:
- **Host**: localhost
- **Port**: 5432
- **Database**: moneymate
- **User**: moneymate_user
- **Password**: moneymate_password

Popular tools:
- [pgAdmin](https://www.pgadmin.org/)
- [DBeaver](https://dbeaver.io/)
- [TablePlus](https://tableplus.com/)

## Production Deployment

For production:

1. Update `.env` with secure passwords and secrets
2. Use production Dockerfile targets
3. Set `NODE_ENV=production`
4. Configure proper CORS origins
5. Use environment-specific secrets management

## Next Steps

Now that everything is running:

1. ✅ Explore the transaction management UI
2. ⏭️ Build UIs for accounts, categories, payees
3. ⏭️ Add investment account management
4. ⏭️ Create budgets and reports
5. ⏭️ Implement data import/export

## Need Help?

- View logs: `docker compose logs -f`
- Check service status: `docker compose ps`
- Restart everything: `docker compose restart`
- Clean start: `docker compose down -v && ./docker-setup.sh`

Happy coding! 🚀
