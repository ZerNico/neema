import type { DocumentToolActivity } from "../client/use-message-stream.ts";

export function documentActivityLabel(activity: DocumentToolActivity) {
  const title = activity.result?.title;
  if (activity.status === "running") {
    if (activity.name === "create_document") return "Creating a document";
    if (activity.name === "edit_document") return "Updating the document";
    if (activity.name === "comment_on_document") return "Commenting";
    return "Reading documents";
  }
  switch (activity.result?.outcome) {
    case "created":
      return title ? `Created ${title}` : "Created a document";
    case "updated":
      return title ? `Updated ${title}` : "Updated a document";
    case "unchanged":
      return title ? `${title} unchanged` : "Document unchanged";
    case "read":
      return title ? `Read ${title}` : "Read a document";
    case "listed":
      return "Checked documents";
    case "commented":
      return title ? `Commented on ${title}` : "Commented on a document";
    default:
      return "Couldn’t update the document";
  }
}
