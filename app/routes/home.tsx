import type { Route } from "./+types/home";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useEffect, useRef } from "react";
import { redirect, useLoaderData } from "react-router";
import { db } from "~/db";
import { dailyBriefTable, medicalDetailTable } from "~/db/schema";
import { eq, count } from "drizzle-orm";
import type { PersonDailyBrief } from "../utils/daily-brief";
import { getDailyBriefsForUser } from "../utils/daily-brief";
import { getPersonForUser } from "~/utils/user";
import { auth } from "~/lib/auth-server";

export async function loader({ request }: Route.LoaderArgs) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw redirect("/login");
  }

  const personForCurrentUser = await getPersonForUser(session.user.id);
  if (!personForCurrentUser) {
    return {
      currentPersonMedicalDetailsCount: undefined,
      dailyBriefs: [],
    };
  }

  // Get the count of medical details for current person, which we'll use to
  // determine whether to display the intro message
  const currentPersonMedicalDetailsCountQuery = await db
    .select({ count: count() })
    .from(medicalDetailTable)
    .where(eq(medicalDetailTable.personId, personForCurrentUser.id));
  const currentPersonMedicalDetailsCount =
    currentPersonMedicalDetailsCountQuery[0].count;

  // Resolve daily briefs for every person created by this user (themself and
  // anyone they've added).
  const dailyBriefs = await getDailyBriefsForUser(session.user.id);

  return {
    currentPersonMedicalDetailsCount,
    dailyBriefs,
  };
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Care Log" },
    {
      name: "description",
      content: "Care Log that advocates for you",
    },
  ];
}

function DailyBriefCard({ personBrief }: { personBrief: PersonDailyBrief }) {
  const { person, brief, generatingPromise } = personBrief;
  const [closed, setClosed] = useState(false);
  const [generatedBrief, setGeneratedBrief] = useState<
    typeof dailyBriefTable.$inferSelect | null
  >(null);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (generatingPromise && !brief) {
      setIsGenerating(true);
      generatingPromise
        .then((generated) => {
          setGeneratedBrief(generated);
          setIsGenerating(false);
        })
        .catch(() => {
          setIsGenerating(false);
        });
    }
  }, [generatingPromise, brief]);

  const currentBrief = brief || generatedBrief;
  const shouldShowBrief = (currentBrief || isGenerating) && !closed;

  if (!shouldShowBrief) {
    return null;
  }

  return (
    <div className="mb-0 rounded-none border-0 border-b border-emerald-200 bg-emerald-50 p-4 shadow-none sm:mb-4 sm:rounded-lg sm:border sm:shadow-lg">
      <div className="mb-2 flex items-start justify-between">
        <h3 className="text-lg font-semibold text-emerald-800">
          Daily Brief — {person.firstName} {person.lastName}
        </h3>
        <button
          onClick={() => setClosed(true)}
          className="p-1 text-emerald-600 hover:text-emerald-800"
          aria-label="Close daily brief"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M6 6L18 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {isGenerating ? (
        <div className="flex items-center space-x-2 text-emerald-700">
          <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-emerald-700"></div>
          <span>Generating the daily brief...</span>
        </div>
      ) : (
        <div className="text-sm whitespace-pre-wrap text-emerald-800">
          {currentBrief?.brief}
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const { currentPersonMedicalDetailsCount, dailyBriefs } =
    useLoaderData<typeof loader>();
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/agent",
    }),
  });
  const [input, setInput] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isScrollingProgrammatically = useRef(false);

  const scrollToBottom = () => {
    isScrollingProgrammatically.current = true;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setAutoScroll(true);
    // Reset flag after scroll animation completes
    setTimeout(() => {
      isScrollingProgrammatically.current = false;
    }, 500);
  };

  const handleScroll = () => {
    if (!scrollContainerRef.current || isScrollingProgrammatically.current)
      return;

    const { scrollTop, scrollHeight, clientHeight } =
      scrollContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight <= 15; // Scroll buffer

    setAutoScroll(isNearBottom);
  };

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll) {
      isScrollingProgrammatically.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
      // Reset flag after scroll animation completes
      setTimeout(() => {
        isScrollingProgrammatically.current = false;
      }, 500);
    }
  }, [messages, autoScroll]);

  const shouldShowIntroMessage =
    messages.length === 0 && !currentPersonMedicalDetailsCount;

  return (
    <div className="mx-auto flex h-dvh max-h-dvh max-w-4xl flex-col p-0 sm:p-6">
      <h1 className="mb-6 hidden text-3xl font-bold text-gray-800 sm:flex">
        Care Log
      </h1>

      {dailyBriefs.map((personBrief) => (
        <DailyBriefCard key={personBrief.person.id} personBrief={personBrief} />
      ))}

      <div className="flex flex-1 flex-col overflow-hidden rounded-none border-0 bg-white shadow-none sm:rounded-lg sm:border sm:border-gray-200 sm:shadow-lg">
        {/* Container for messages, thinking indicator, and end ref */}
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {/* Scrollable container for messages */}
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto border-b border-gray-200 p-4"
          >
            <div className="py-8 text-center text-gray-600">
              {shouldShowIntroMessage ? (
                <>
                  You or your family have any medical issues?
                  <br />
                  <br />
                  Tell me what's going on and I'll help you get better.
                  <br />
                  <br />
                  I'll keep track of details so you don't have to enter them
                  each time.
                </>
              ) : (
                <>How are you feeling today?</>
              )}
            </div>

            {messages.map((message) => (
              <div
                key={message.id}
                className={`mb-4 rounded-lg p-3 ${
                  message.role === "user"
                    ? "ml-8 border border-sky-200 bg-sky-50"
                    : "mr-8 border border-gray-200 bg-gray-100"
                }`}
              >
                <div className="whitespace-pre-wrap text-gray-800">
                  {message.parts.map((part, index) => {
                    if (part.type === "text") {
                      return <span key={index}>{part.text}</span>;
                    }

                    if (part.type.startsWith("tool-")) {
                      const toolName = part.type.replace("tool-", "");

                      // Type guard to check if part has the required properties
                      if (!("state" in part)) return null;

                      switch (part.state) {
                        case "input-streaming":
                          return (
                            <div
                              key={index}
                              className="my-2 rounded border-l-4 border-amber-400 bg-amber-50 p-2"
                            >
                              <div className="text-sm font-medium text-amber-800">
                                🔧 Calling {toolName}...
                              </div>
                            </div>
                          );

                        case "input-available":
                          return (
                            <div
                              key={index}
                              className="my-2 rounded border-l-4 border-sky-400 bg-sky-50 p-2"
                            >
                              <div className="mb-1 text-sm font-medium text-sky-800">
                                🔧 {toolName}
                              </div>
                              <div className="text-xs text-sky-700">
                                {"input" in part
                                  ? JSON.stringify(part.input, null, 2)
                                  : ""}
                              </div>
                            </div>
                          );

                        case "output-available":
                          return (
                            <div
                              key={index}
                              className="my-2 rounded border-l-4 border-emerald-400 bg-emerald-50 p-2"
                            >
                              <div className="mb-1 text-sm font-medium text-emerald-800">
                                ✅ {toolName} completed
                              </div>
                              <div className="text-xs whitespace-pre-wrap text-emerald-700">
                                {"output" in part
                                  ? typeof part.output === "string"
                                    ? part.output
                                    : JSON.stringify(part.output, null, 2)
                                  : ""}
                              </div>
                            </div>
                          );

                        case "output-error":
                          return (
                            <div
                              key={index}
                              className="my-2 rounded border-l-4 border-red-400 bg-red-50 p-2"
                            >
                              <div className="mb-1 text-sm font-medium text-red-800">
                                ❌ {toolName} failed
                              </div>
                              <div className="text-xs text-red-700">
                                {"errorText" in part
                                  ? part.errorText || "Unknown error"
                                  : "Unknown error"}
                              </div>
                            </div>
                          );
                      }
                    }

                    return null;
                  })}
                </div>
              </div>
            ))}

            {status !== "ready" && (
              <div className="py-2 text-center text-gray-600">
                Agent is thinking...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="absolute right-4 bottom-4 rounded-full bg-emerald-600 p-2 text-white shadow-lg transition-colors hover:bg-emerald-700"
              aria-label="Scroll to bottom"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M7 14L12 19L17 14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M7 5L12 10L17 5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) {
              sendMessage({ text: input });
              setInput("");
            }
          }}
          className="p-4"
        >
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                !currentPersonMedicalDetailsCount
                  ? "What's going on?"
                  : "Your message..."
              }
              className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500 focus:outline-none"
              disabled={status !== "ready"}
            />
            <button
              type="submit"
              disabled={status !== "ready" || !input.trim()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
