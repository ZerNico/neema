import { Schema } from "effect";
import { MACHINE_HELLO_HEADER, MachineHello } from "@chat/desktop-rpc";
import { markedDesktop } from "~/modules/auth/server/desktop-sessions.ts";
import { approvedSession } from "~/server/approved-route.ts";

const decodeHello = Schema.decodeUnknownOption(Schema.fromJsonString(MachineHello));

/**
 * The person behind a machine's request, and the machine it says it is. Only a desktop session
 * (minted by the desktop sign-in) may act as a machine: a browser session holds no machine and
 * must not be able to receive another device's calls. The machine id is the install's own claim;
 * it is scoped to the person, so it can only ever name one of their own machines.
 */
export const machineRequest = async (request: Request) => {
  const session = await approvedSession(request);
  if (!session || !markedDesktop(session.session)) return null;
  const hello = decodeHello(request.headers.get(MACHINE_HELLO_HEADER) ?? "");
  if (hello._tag !== "Some") return null;
  return { session, userId: session.user.id, hello: hello.value };
};

export const badRequest = () => new Response("Bad Request", { status: 400 });
