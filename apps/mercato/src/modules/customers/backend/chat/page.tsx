import { notFound } from 'next/navigation'

/**
 * Public-chat management is deliberately absent from the launch UI. The route
 * remains registered so existing links fail closed without exposing controls
 * that could create, activate, publish, embed, delete, send, or dispatch chat.
 */
export default function ChatPage(): never {
  notFound()
}
