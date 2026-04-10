const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
});

const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id UUID PRIMARY KEY NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      status VARCHAR(50) NOT NULL,
      severity VARCHAR(50) NOT NULL,
      assigned_team VARCHAR(100),
      vector_clock JSONB NOT NULL,
      version_conflict BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    
  `);
};

module.exports = { pool, initDB };
