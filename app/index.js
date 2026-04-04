const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { pool, initDB } = require('./db');

const app = express();
app.use(express.json());

const REGION_ID = process.env.REGION_ID;
const OTHER_REGIONS = (process.env.OTHER_REGIONS || '').split(',').filter(Boolean);
const PORT = process.env.PORT || 8080;

// Helper to compare vector clocks
const compareClocks = (vc1, vc2) => {
  let isBefore = false;
  let isAfter = false;

  const keys = new Set([...Object.keys(vc1), ...Object.keys(vc2)]);

  for (const key of keys) {
    const val1 = vc1[key] || 0;
    const val2 = vc2[key] || 0;

    if (val1 < val2) isBefore = true;
    else if (val1 > val2) isAfter = true;
  }

  if (isBefore && isAfter) return 'CONCURRENT';
  if (isBefore) return 'BEFORE';
  if (isAfter) return 'AFTER';
  return 'EQUAL';
};

const mergeClocks = (vc1, vc2) => {
  const merged = {};
  const keys = new Set([...Object.keys(vc1), ...Object.keys(vc2)]);
  for (const key of keys) {
    merged[key] = Math.max(vc1[key] || 0, vc2[key] || 0);
  }
  return merged;
};

// 3. Create Incident
app.post('/incidents', async (req, res) => {
  const { title, description, severity } = req.body;
  const id = uuidv4();
  const vector_clock = { "us": 0, "eu": 0, "apac": 0 };
  vector_clock[REGION_ID] = 1;

  try {
    const result = await pool.query(
      `INSERT INTO incidents (id, title, description, status, severity, vector_clock, version_conflict)
       VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *`,
      [id, title, description || null, 'OPEN', severity, vector_clock]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Update Incident
app.put('/incidents/:id', async (req, res) => {
  const id = req.params.id;
  const incomingData = req.body;
  const reqVc = incomingData.vector_clock;

  if (!reqVc) {
    return res.status(400).json({ error: "vector_clock missing" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [id]);
    
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Not found" });
    }

    const localIncident = existing.rows[0];
    const localVc = localIncident.vector_clock;
    const comp = compareClocks(reqVc, localVc);

    if (comp === 'BEFORE') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: "Conflict: Stale update" });
    }
    
    reqVc[REGION_ID] = (reqVc[REGION_ID] || 0) + 1;
    
    const updateResult = await client.query(
      `UPDATE incidents 
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           severity = COALESCE($4, severity),
           assigned_team = COALESCE($5, assigned_team),
           vector_clock = $6,
           updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [
        incomingData.title,
        incomingData.description,
        incomingData.status,
        incomingData.severity,
        incomingData.assigned_team,
        reqVc,
        id
      ]
    );

    await client.query('COMMIT');
    res.json(updateResult.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// 5. & 6. & 10. Replicate Incident
app.post('/internal/replicate', async (req, res) => {
  const inc = req.body;
  const vc_in = inc.vector_clock;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [inc.id]);
    
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO incidents (id, title, description, status, severity, assigned_team, vector_clock, version_conflict)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [inc.id, inc.title, inc.description, inc.status, inc.severity, inc.assigned_team, vc_in, inc.version_conflict]
      );
    } else {
      const localIncident = existing.rows[0];
      const vc_local = localIncident.vector_clock;
      const comp = compareClocks(vc_in, vc_local);
      
      if (comp === 'AFTER') {
        const mergedVc = mergeClocks(vc_in, vc_local);
        await client.query(
          `UPDATE incidents
           SET title = $1, description = $2, status = $3, severity = $4, assigned_team = $5, vector_clock = $6, version_conflict = $7, updated_at = NOW()
           WHERE id = $8`,
          [inc.title, inc.description, inc.status, inc.severity, inc.assigned_team, mergedVc, inc.version_conflict, inc.id]
        );
      } else if (comp === 'CONCURRENT') {
        const mergedVc = mergeClocks(vc_in, vc_local);
        await client.query(
          `UPDATE incidents
           SET vector_clock = $1, version_conflict = true, updated_at = NOW()
           WHERE id = $2`,
          [mergedVc, inc.id]
        );
      }
      // BEFORE or EQUAL are ignored (Idempotency)
    }
    
    await client.query('COMMIT');
    res.status(200).send();
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// 7. Conflict Resolution
app.post('/incidents/:id/resolve', async (req, res) => {
  const id = req.params.id;
  const updateData = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [id]);
    
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Not found" });
    }

    const localIncident = existing.rows[0];
    if (!localIncident.version_conflict) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "No conflict to resolve" });
    }

    let vc = localIncident.vector_clock;
    vc[REGION_ID] = (vc[REGION_ID] || 0) + 1;
    
    const updateResult = await client.query(
      `UPDATE incidents 
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status),
           severity = COALESCE($4, severity),
           assigned_team = COALESCE($5, assigned_team),
           vector_clock = $6,
           version_conflict = false,
           updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [
        updateData.title,
        updateData.description,
        updateData.status,
        updateData.severity,
        updateData.assigned_team,
        vc,
        id
      ]
    );

    await client.query('COMMIT');
    res.json(updateResult.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Partition Simulation Endpoints
let PARTITION_ACTIVE = false;

app.post('/internal/partition/start', (req, res) => {
  PARTITION_ACTIVE = true;
  res.status(200).send({ message: 'Partition started: replication blocked' });
});

app.post('/internal/partition/stop', (req, res) => {
  PARTITION_ACTIVE = false;
  res.status(200).send({ message: 'Partition stopped: replication restored' });
});

app.get('/incidents/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM incidents WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(existing.rows[0]);
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

// Replicate background job
const replicateData = async () => {
  if (OTHER_REGIONS.length === 0 || PARTITION_ACTIVE) return;
  
  try {
    const existing = await pool.query('SELECT * FROM incidents ORDER BY updated_at DESC LIMIT 100');
    const incidents = existing.rows;
    for (const url of OTHER_REGIONS) {
      for (const inc of incidents) {
        try {
          await axios.post(`${url}/internal/replicate`, inc, { timeout: 2000 });
        } catch (err) {
          // Ignore replication errors (e.g. network partition)
        }
      }
    }
  } catch (err) {
    console.error("Replication read error:", err.message);
  }
};

setInterval(replicateData, 3000);

const start = async () => {
  let retries = 5;
  while(retries > 0) {
    try {
      await initDB();
      console.log('Database initialized successfully');
      break;
    } catch(err) {
      console.log('Database init failed, retrying in 3s...', err.message);
      retries -= 1;
      await new Promise(res => setTimeout(res, 3000));
    }
  }
  
  app.listen(PORT, () => {
    console.log(`Region ${REGION_ID} listening on port ${PORT}`);
  });
};

start();
