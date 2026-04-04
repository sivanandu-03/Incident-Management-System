async function runTest() {
  const US = 'http://localhost:8081';
  const EU = 'http://localhost:8082';
  const APAC = 'http://localhost:8083';

  console.log("=> Step 1: Create incident in US");
  const createRes = await fetch(`${US}/incidents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({title: "DB Outage", severity: "HIGH"})
  });
  const createdData = await createRes.json();
  const incidentId = createdData.id;
  console.log(`Created: ${incidentId}`);

  console.log("=> Step 2: Waiting 5s for replication...");
  await new Promise(r => setTimeout(r, 5000));

  const euRes1 = await fetch(`${EU}/incidents/${incidentId}`);
  const euData1 = await euRes1.json();
  console.log("Incident in EU: ", euData1);
  const vc = euData1.vector_clock;

  console.log("=> Step 3: Trigger Partition (block replication)");
  await fetch(`${US}/internal/partition/start`, {method: 'POST'});
  await fetch(`${EU}/internal/partition/start`, {method: 'POST'});
  await fetch(`${APAC}/internal/partition/start`, {method: 'POST'});

  console.log("=> Step 4 & 5: Concurrent update in US and EU using identical vector clock base");
  await fetch(`${US}/incidents/${incidentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: "ACKNOWLEDGED", vector_clock: vc })
  });
  await fetch(`${EU}/incidents/${incidentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: "CRITICAL", vector_clock: vc })
  });

  console.log("=> Step 6: Stop Partition");
  await fetch(`${US}/internal/partition/stop`, {method: 'POST'});
  await fetch(`${EU}/internal/partition/stop`, {method: 'POST'});
  await fetch(`${APAC}/internal/partition/stop`, {method: 'POST'});

  console.log("=> Step 7: Waiting 5s for replication reconciliation...");
  await new Promise(r => setTimeout(r, 5000));

  console.log("=> Step 8: Checking conflicted incident in EU");
  const euResFinal = await fetch(`${EU}/incidents/${incidentId}`);
  const euDataFinal = await euResFinal.json();
  
  console.log("FINAL EU STATE:");
  console.log(JSON.stringify(euDataFinal, null, 2));
  
  if (euDataFinal.version_conflict === true) {
    console.log("\n✅ SUCCESS: The system correctly identified the concurrent updates and set version_conflict to true! Partial logic merged.");
  } else {
    console.error("\n❌ FAIL: version_conflict is NOT true.");
  }
}

runTest();
