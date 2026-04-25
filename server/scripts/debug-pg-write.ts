import { openDriver } from '../src/storage/migrate.js';

async function main() {
  const pg = await openDriver('pg');
  
  const testConversationId = 'aba2497c-c027-4b95-9b4a-30cf7903f79b';
  const testEvents = [
    { eventId: 'test-1', kind: 'user_message', payload: { content: 'test' }, createdAt: Date.now() }
  ];
  
  console.log('Attempting to append events to pg...');
  try {
    await pg.appendAgentEvents({ conversationId: testConversationId, events: testEvents });
    console.log('Success!');
    
    // Check if events were written
    const events = await pg.readAgentEvents({ conversationId: testConversationId, afterSeq: 0, limit: 10 });
    console.log('Events in pg after write:', events.length);
  } catch (err) {
    console.error('Error:', err);
  }
  
  await pg.close();
}

main().catch(console.error);
