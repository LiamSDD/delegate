import Link from "next/link";

export default function AssistantNotFound() {
  return (
    <div className="mx-auto flex max-w-content flex-col gap-4 px-6 pt-16 pb-24">
      <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
        Assistant · 404
      </p>
      <h1 className="font-serif text-display-sm tracking-display">
        This assistant is not available
      </h1>
      <p className="max-w-xl text-md text-text-muted">
        It does not exist, belongs to another session, or was deleted: demo workspaces are deleted
        after 7 days.
      </p>
      <Link
        href="/agents"
        className="inline-flex h-9 w-fit items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
      >
        Your agents
      </Link>
    </div>
  );
}
