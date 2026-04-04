#!/bin/bash

# Configuration
US_URL="http://localhost:8081"
EU_URL="http://localhost:8082"
APAC_URL="http://localhost:8083"

echo "============================================="
echo "   Multi-Region Network Partition scenario   "
echo "============================================="

# 1. Create a new incident via region-us
echo ""
echo "=> Step 1: Creating a new incident in region-us..."
CREATE_RES=$(curl -s -X POST $US_URL/incidents -H "Content-Type: application/json" -d '{"title":"Database Outage","severity":"HIGH"}')
INCIDENT_ID=$(echo $CREATE_RES | jq -r '.id')
echo "Created incident ID: $INCIDENT_ID"

# 2. Wait for replication
echo ""
echo "=> Step 2: Waiting for incident to replicate to region-eu and region-apac (approx 5 seconds)..."
sleep 5

EU_STATE=$(curl -s $EU_URL/incidents/$INCIDENT_ID)
echo "Incident in region-eu after replication:"
echo $EU_STATE | jq .

VECTOR_CLOCK=$(echo $EU_STATE | jq '.vector_clock')

# 3. Simulate Partition
echo ""
echo "=> Step 3: Simulating a partition by blocking replication between US and EU (and APAC)"
curl -s -X POST $US_URL/internal/partition/start > /dev/null
curl -s -X POST $EU_URL/internal/partition/start > /dev/null
curl -s -X POST $APAC_URL/internal/partition/start > /dev/null

echo "Partition started. US, EU and APAC cannot replicate."

# 4. Update in US
echo ""
echo "=> Step 4: Updating the incident in region-us (concurrent change 1)"
US_UPDATE_PAYLOAD=$(jq -n \
  --arg status "ACKNOWLEDGED" \
  --argjson vc "$VECTOR_CLOCK" \
  '{status: $status, vector_clock: $vc}')

curl -s -X PUT $US_URL/incidents/$INCIDENT_ID \
     -H "Content-Type: application/json" \
     -d "$US_UPDATE_PAYLOAD" > /dev/null
echo "Updated incident in region-us to ACKNOWLEDGED"

# 5. Update in EU
echo ""
echo "=> Step 5: Updating the same incident in region-eu (concurrent change 2)"
EU_UPDATE_PAYLOAD=$(jq -n \
  --arg status "CRITICAL" \
  --argjson vc "$VECTOR_CLOCK" \
  '{status: $status, assigned_team: "EU-Ops", vector_clock: $vc}')

curl -s -X PUT $EU_URL/incidents/$INCIDENT_ID \
     -H "Content-Type: application/json" \
     -d "$EU_UPDATE_PAYLOAD" > /dev/null
echo "Updated incident in region-eu to CRITICAL"

# 6. Remove partition
echo ""
echo "=> Step 6: Healing network partition (restoring replication)"
curl -s -X POST $US_URL/internal/partition/stop > /dev/null
curl -s -X POST $EU_URL/internal/partition/stop > /dev/null
curl -s -X POST $APAC_URL/internal/partition/stop > /dev/null

# 7. Trigger Replication
echo ""
echo "=> Step 7: Waiting for replication to occur (approx 5 seconds)..."
sleep 5

# 8. Fetch conflicted incident from region-eu
echo ""
echo "=> Step 8: Fetching incident from region-eu to check version_conflict"
FINAL_EU_STATE=$(curl -s $EU_URL/incidents/$INCIDENT_ID)

echo ""
echo "============================================="
echo "               FINAL OUTCOME                 "
echo "============================================="
echo $FINAL_EU_STATE | jq .

IS_CONFLICT=$(echo $FINAL_EU_STATE | jq '.version_conflict')
if [ "$IS_CONFLICT" == "true" ]; then
    echo ""
    echo "SUCCESS: The system correctly identified the concurrent "
    echo "updates and set version_conflict to true!"
else
    echo ""
    echo "FAIL: The version_conflict is NOT set to true."
fi
