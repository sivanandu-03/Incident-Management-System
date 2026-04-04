# Multi-Region Incident Management System

A distributed backend for a multi-region incident management system that guarantees causal ordering using vector clocks. This system consists of three regional servers (US, EU, APAC) communicating over HTTP to perform asynchronous bidirectional replication of incidents while robustly detecting and preventing update conflicts.

## Architecture Architecture Overview

- **3 independently deployable Region Services** built with Node.js + Express.
- **3 dedicated PostgreSQL databases**, one attached to each region for decoupled storage.
- **Vector Clocks (VCs)** attached to every incident model, providing complete causal ordering of incidents across boundaries without relying on physical network wall clocks.
- **Conflict detection & resolving mechanisms**: The system detects concurrent modifications made to identical incidents across regions and flags them cleanly for human or automated mediation.
- **Idempotency**: All cross-region synchronization triggers are idempotent and can handle delayed, misrouted, duplicated, or dropped packets effortlessly.

## Requirements

1. Docker & Docker Compose
2. cURL
3. jq (command-line JSON processor)

## Getting Started

1. Clone or extract this repository.
2. Initialize environment variables. By default, values found in `.env.example` apply. 
   ```bash
   cp .env.example .env
   ```
3. Start the entire cluster using Docker Compose:
   ```bash
   docker-compose up --build
   ```

Wait until you see health checks succeed for all 6 containers. Database migrations are applied automatically on startup before regions bind to ports.

## Service Endpoints

Each service region listens on a distinct port (US: `8081`, EU: `8082`, APAC: `8083`).

- `POST /incidents` - Create a new incident. (Initializes VC).
- `GET /incidents/:id` - Fetch an incident.
- `PUT /incidents/:id` - Perform an update using local known VC. Will reject stale references (`409 Conflict`).
- `POST /incidents/:id/resolve` - Given a conflicted incident (`version_conflict: true`), selects fields & resolves state.
- `POST /internal/replicate` (Internal Use) - Cross-service asynchronous exchange.
- `POST /internal/partition/start` & `POST /internal/partition/stop` (Internal Use for simulation testing)

## Demonstration of Fault Tolerance / Network Partitions

Vector clocks exist specifically to counter split-brain scenarios! Run the simulation wrapper script which handles complex API states out of the box. The shell script orchestrates multi-agent update races.

```bash
chmod +x simulate_partition.sh
./simulate_partition.sh
```

## System Implementation Nuances

Our system models VCs natively using JSON maps. When instances modify states internally, their region's key scalar within the active dictionary increments by 1. By executing element-wise maxima operations on merging states and enforcing less/greater vector boundary inequalities during sync tasks, causality is permanently strictly mapped!
