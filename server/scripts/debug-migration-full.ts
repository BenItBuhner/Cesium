import { openDriver } from '../src/storage/migrate.js';
import type { AppendAgentEventsInput } from '../src/storage/driver.js';

async function main() {
  const from = await openDriver('legacy-json');
  const to = await openDriver('pg');
  
  const conversationId = 'aba2497c-c027-4b95-9b4a-30cf7903f79b';
  
  // Check existing state in target
  console.log('Checking target conversation state...');
  const existing = await to.getAgentConversation(conversationId);
  console.log('Existing conversation:', existing ? { id: existing.id, lastEventSeq: existing.lastEventSeq } : null);
  
  // Read events from source
  console.log('\nReading events from source...');
  const batch = await from.readAgentEvents({ conversationId, afterSeq: 0, limit: 10 });
  console.log('Source events batch:', batch.length);
  
  if (batch.length > 0) {
    // Check what would be migrated
    const events: AppendAgentEventsInput["events"] = batch.map((event) => {
      const { seq, ...rest } = event;
      void seq;
      return rest;
    });
    console.log('\nPrepared events for pg:', events.length);
    
    // Try appending
    console.log('\nAttempting appendAgentEvents...');
    await to.appendAgentEvents({ conversationId, events });
    console.log('Appended!');
    
    // Verify
    const after = await to.readAgentEvents({ conversationId, afterSeq: 0, limit: 100 });
    console.log('Events after migration:', after.length);
  }
  
  await from.close();
  await to.close();
}

main().catch(console.error);
