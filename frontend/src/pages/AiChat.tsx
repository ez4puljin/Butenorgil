import ChatView from "../components/ai/ChatView";

/* AI туслах — бүтэн хуудас. Бусад цэсэнд баруун доод буланд мөн гарна (components/ai/AiAssistant). */
export default function AiChatPage() {
  return (
    <div className="h-[calc(100vh-5rem)] overflow-hidden rounded-2xl shadow-sm lg:h-[calc(100vh-2.5rem)]">
      <ChatView page={{ menu: "AI туслах", path: "/ai-chat", ids: [] }} />
    </div>
  );
}
