import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prompt-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} rel="noreferrer noopener">{children}</a>
          ),
        }}
      >
        {source || ""}
      </ReactMarkdown>
    </div>
  );
}
