import type { InviteResult, RemoveResult } from "@/auth/managers";

/** What the owner is told after inviting or removing someone. Pure; used by the client forms. */
export interface Notice {
  tone: "success" | "warning" | "error";
  text: string;
}

export function inviteNotice(result: InviteResult, loginUrl: string): Notice {
  switch (result.status) {
    case "invited":
      return result.emailSent
        ? { tone: "success", text: `Invited ${result.email}. We emailed them a sign-in link.` }
        : {
            tone: "warning",
            text:
              `${result.email} can now sign in, but the invitation email could not be sent ` +
              `(${result.emailError}). Ask them to sign in at ${loginUrl} with this email.`,
          };
    case "already-listed":
      return { tone: "warning", text: `${result.email} already has access (${result.role}). Nothing changed.` };
    case "invalid-email":
      return { tone: "error", text: "Enter a valid email address." };
    case "forbidden":
      return { tone: "error", text: "Only the clinic owner can invite managers." };
  }
}

export function removeNotice(result: RemoveResult): Notice {
  switch (result.status) {
    case "removed":
      return { tone: "success", text: `Removed ${result.email}. They no longer have access.` };
    case "not-listed":
      return { tone: "warning", text: `${result.email || "That email"} is not on the list.` };
    case "protected":
      return {
        tone: "error",
        text:
          result.reason === "yourself"
            ? "You can't remove yourself."
            : `${result.email} is an owner. Owners can't be removed here.`,
      };
    case "forbidden":
      return { tone: "error", text: "Only the clinic owner can remove managers." };
  }
}
