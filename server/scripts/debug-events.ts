import { legacyFsReadConversationEventsSince, getConversationEventsFile } from '../src/lib/agents/session-store-legacy-fs.js';

const workspaceId = 'ef97866e8100';
const conversationId = 'd858080e-cd92-43cd-ae20-a624a279cdd6';

const filePath = getConversationEventsFile(workspaceId, conversationId);
console.log('File path:', filePath);

const events = await legacyFsReadConversationEventsSince(workspaceId, conversationId, 0);
console.log('Events count:', events.length);
console.log('First 3 events:', JSON.stringify(events.slice(0, 3), null, 2));
