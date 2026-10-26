// Threads, messages, deliveries, inbox, notices, and files (WP2).
//
// The store is the only writer of the WP2 tables. Handlers call into it, and tests call it
// directly for behaviors that have no route, such as notices (NTC-01).
//
// WP3: attach a replacement delivery hook with `runtime.delivery = { onDelivered }` (see
// `delivery.ts`). It runs inside the append transaction, once per delivery row.

export {
	addressList,
	archiveThread,
	createThread,
	inbox,
	inboxThreads,
	isThreadArchived,
	messageBody,
	postNotice,
	snippetOf,
	readMessage,
	readThread,
	redactMessage,
	respond,
	reviseMessage,
	type CreateThreadInput,
	type ArchiveState,
	type FileRecord,
	type InboxDelivery,
	type InboxRecipient,
	type InboxThread,
	type MessageView,
	type NoticeInput,
	type ParticipantKind,
	type PersonView,
	type ReadMessageOptions,
	type RespondInput,
	type ThreadResult,
	type ThreadView,
} from "./store.ts";
export {
	configureDelivery,
	defaultDeliveryHooks,
	deliveryHooks,
	type DeliveredEvent,
	type DeliveryHooks,
	type RuntimeWithDelivery,
} from "./delivery.ts";
export {
	appendAttachmentMarkdown,
	attachmentMarkdown,
	loadFile,
	mediaTypeFor,
	safeName,
	uploadFile,
	type FileUploader,
	type FileView,
	type LoadedFile,
	type UploadInput,
} from "./files.ts";
