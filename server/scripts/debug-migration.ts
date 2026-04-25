import { openDriver } from '../src/storage/migrate.js';

async function main() {
  const legacy = await openDriver('legacy-json');
  
  // List conversations
  const conversations = await legacy.listAgentConversations({ limit: 20, includeArchived: true });
  console.log('Conversations:', conversations.records.length);
  
  for (const conv of conversations.records.slice(0, 3)) {
    console.log('\nConversation:', conv.id, 'workspace:', conv.workspaceId);
    
    // Try reading events
    const events = await legacy.readAgentEvents({ conversationId: conv.id, afterSeq: 0, limit: 10 });
    console.log('Events found:', events.length);
    if (events.length > 0) {
      console.log('First event:', JSON.stringify(events[0]).slice(0, 200));
    }
  }
  
  await legacy.close();
}

main().catch(console.error);
