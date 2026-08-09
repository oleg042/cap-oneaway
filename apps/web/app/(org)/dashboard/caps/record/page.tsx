import type { Metadata } from "next";
import { EmbedRecorder } from "./EmbedRecorder";

export const metadata: Metadata = {
	title: "Record a Tape",
};

// OneAway only supports the branded in-browser recorder — there is no Tape desktop app and no Chrome
// extension. So this route ALWAYS renders the minimal branded recorder, never Cap's stock chooser
// (Open Tape Desktop / Record in Browser / Add to Chrome / FAQ), regardless of the ?embed param. The portal
// still opens it with ?embed=1 (+ the tape_embed cookie) so the dashboard layout drops its chrome; hitting
// the URL directly now shows the same clean recorder instead of the confusing Cap chooser.
export default function RecordVideoRoute() {
	return <EmbedRecorder />;
}
