// The coding reader needs its own processor; the thread UI's host resizer does not prepare
// model inputs. pi-durable's Node adapter handles orientation, dimensions, and base64 size
// limits in a worker, whose WASM memory is released after it goes idle. No host CLI is needed.
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

let processor: Promise<ImageProcessor> | undefined;

/** Share one lazy worker-backed processor across panad's registries. */
export const nodeImages: ImageProcessor = {
	async prepare(bytes, mimeType, limits) {
		processor ??= createNodePhotonImages();
		// Buffer.slice() retains its pooled backing store, which a worker cannot transfer.
		return (await processor).prepare(Uint8Array.from(bytes), mimeType, limits);
	},
};
