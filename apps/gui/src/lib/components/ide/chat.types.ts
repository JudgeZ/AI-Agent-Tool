export type ChatMessage = {
  id: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
};

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type MessageCaches = {
  messageCache: Map<string, ChatMessage>;
  messageSignatureCache: Map<string, string>;
};
