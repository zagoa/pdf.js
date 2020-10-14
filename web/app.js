/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals PDFBug, Stats */

import {
  DEFAULT_SCALE_VALUE,
  EventBus,
  getPDFFileNameFromURL,
  MAX_SCALE,
  MIN_SCALE,
  noContextMenuHandler,
  parseQueryString,
  ProgressBar,
} from "./ui_utils.js";
import {AppOptions, OptionKind} from "./app_options.js";
import {
  createPromiseCapability,
  getDocument,
  getFilenameFromUrl,
  GlobalWorkerOptions,
  LinkTarget,
  shadow,
} from "pdfjs-lib";
import {PDFCursorTools} from "./pdf_cursor_tools.js";
import {PDFRenderingQueue} from "./pdf_rendering_queue.js";
import {PDFSidebar} from "./pdf_sidebar.js";
import {OverlayManager} from "./overlay_manager.js";
import {PDFAttachmentViewer} from "./pdf_attachment_viewer.js";
import {PDFDocumentProperties} from "./pdf_document_properties.js";
import {PDFFindController} from "./pdf_find_controller.js";
import {PDFHistory} from "./pdf_history.js";
import {PDFLinkService} from "./pdf_link_service.js";
import {PDFOutlineViewer} from "./pdf_outline_viewer.js";
import {PDFPresentationMode} from "./pdf_presentation_mode.js";
import {PDFSidebarResizer} from "./pdf_sidebar_resizer.js";
import {PDFThumbnailViewer} from "./pdf_thumbnail_viewer.js";
import {PDFViewer} from "./pdf_viewer.js";
import {SecondaryToolbar} from "./secondary_toolbar.js";
import {Toolbar} from "./toolbar.js";
import {ViewHistory} from "./view_history.js";

const DEFAULT_SCALE_DELTA = 1.1;
const DISABLE_AUTO_FETCH_LOADING_BAR_TIMEOUT = 5000; // ms
const ENABLE_PERMISSIONS_CLASS = "enablePermissions";


class DefaultExternalServices {
  constructor() {
    throw new Error("Cannot initialize DefaultExternalServices.");
  }

  static updateFindControlState(data) {
  }

  static updateFindMatchesCount(data) {
  }

  static initPassiveLoading(callbacks) {
  }

  static fallback(data, callback) {
  }

  static reportTelemetry(data) {
  }

  static createDownloadManager(options) {
    throw new Error("Not implemented: createDownloadManager");
  }

  static createPreferences() {
    throw new Error("Not implemented: createPreferences");
  }

  static createL10n(options) {
    throw new Error("Not implemented: createL10n");
  }

  static get supportsIntegratedFind() {
    return shadow(this, "supportsIntegratedFind", false);
  }

  static get supportsDocumentFonts() {
    return shadow(this, "supportsDocumentFonts", true);
  }

  static get supportedMouseWheelZoomModifierKeys() {
    return shadow(this, "supportedMouseWheelZoomModifierKeys", {
      ctrlKey: true,
      metaKey: true,
    });
  }

  static get isInAutomation() {
    return shadow(this, "isInAutomation", false);
  }
}

const PDFViewerApplication = {
  initialBookmark: document.location.hash.substring(1),
  _initializedCapability: createPromiseCapability(),
  fellback: false,
  appConfig: null,
  pdfDocument: null,
  pdfLoadingTask: null,
  printService: null,
  /** @type {PDFViewer} */
  pdfViewer: null,
  /** @type {PDFThumbnailViewer} */
  pdfThumbnailViewer: null,
  /** @type {PDFRenderingQueue} */
  pdfRenderingQueue: null,
  /** @type {PDFPresentationMode} */
  pdfPresentationMode: null,
  /** @type {PDFDocumentProperties} */
  pdfDocumentProperties: null,
  /** @type {PDFLinkService} */
  pdfLinkService: null,
  /** @type {PDFHistory} */
  pdfHistory: null,
  /** @type {PDFSidebar} */
  pdfSidebar: null,
  /** @type {PDFSidebarResizer} */
  pdfSidebarResizer: null,
  /** @type {PDFOutlineViewer} */
  pdfOutlineViewer: null,
  /** @type {PDFAttachmentViewer} */
  pdfAttachmentViewer: null,
  /** @type {PDFCursorTools} */
  pdfCursorTools: null,
  /** @type {ViewHistory} */
  store: null,
  /** @type {DownloadManager} */
  downloadManager: null,
  /** @type {OverlayManager} */
  overlayManager: null,
  /** @type {Preferences} */
  preferences: null,
  /** @type {Toolbar} */
  toolbar: null,
  /** @type {SecondaryToolbar} */
  secondaryToolbar: null,
  /** @type {EventBus} */
  eventBus: null,
  /** @type {IL10n} */
  l10n: null,
  isInitialViewSet: false,
  downloadComplete: false,
  isViewerEmbedded: window.parent !== window,
  url: "",
  baseUrl: "",
  externalServices: DefaultExternalServices,
  _boundEvents: {},
  contentDispositionFilename: null,

  // Called once when the document is loaded.
  async initialize(appConfig) {
    // this.preferences = this.externalServices.createPreferences();
    this.appConfig = appConfig;

    if (
      this.isViewerEmbedded &&
      AppOptions.get("externalLinkTarget") === LinkTarget.NONE
    ) {
      // Prevent external links from "replacing" the viewer,
      // when it's embedded in e.g. an <iframe> or an <object>.
      // AppOptions.set("externalLinkTarget", LinkTarget.TOP);
    }
    await this._initializeViewerComponents();

    this._initializedCapability.resolve();
  },
  /**
   * @private
   */
  async _initializeViewerComponents() {
    const appConfig = this.appConfig;

    const eventBus =
      appConfig.eventBus ||
      new EventBus();
    this.eventBus = eventBus;

    this.overlayManager = new OverlayManager();

    const pdfRenderingQueue = new PDFRenderingQueue();
    // pdfRenderingQueue.onIdle = this.cleanup.bind(this);
    this.pdfRenderingQueue = pdfRenderingQueue;

    const pdfLinkService = new PDFLinkService({
      eventBus
    });
    this.pdfLinkService = pdfLinkService;

    const findController = new PDFFindController({
      linkService: pdfLinkService,
      eventBus,
    });
    this.findController = findController;

    const container = appConfig.mainContainer;

    this.pdfViewer = new PDFViewer({
      container,
      // viewer,
      eventBus,
      renderingQueue: pdfRenderingQueue,
      // linkService: pdfLinkService,
      // downloadManager,
      findController,
      // renderer: AppOptions.get("renderer"),
      // enableWebGL: AppOptions.get("enableWebGL"),
      // l10n: this.l10n,
      // textLayerMode: AppOptions.get("textLayerMode"),
      // imageResourcesPath: AppOptions.get("imageResourcesPath"),
      // renderInteractiveForms: AppOptions.get("renderInteractiveForms"),
      // enablePrintAutoRotate: AppOptions.get("enablePrintAutoRotate"),
      // useOnlyCssZoom: AppOptions.get("useOnlyCssZoom"),
      // maxCanvasPixels: AppOptions.get("maxCanvasPixels"),
    });
    pdfRenderingQueue.setViewer(this.pdfViewer);
    pdfLinkService.setViewer(this.pdfViewer);

    this.secondaryToolbar = new SecondaryToolbar(
      appConfig.secondaryToolbar,
      container,
      eventBus
    );
  },

  run(config) {
    console.warn('RUN', config);

    this.initialize(config).then(webViewerInitialized);
  },

  get initialized() {
    return this._initializedCapability.settled;
  },

  get initializedPromise() {
    return this._initializedCapability.promise;
  },

  zoomIn(ticks) {
    if (this.pdfViewer.isInPresentationMode) {
      return;
    }
    let newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale * DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.ceil(newScale * 10) / 10;
      newScale = Math.min(MAX_SCALE, newScale);
    } while (--ticks > 0 && newScale < MAX_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
  },

  zoomOut(ticks) {
    if (this.pdfViewer.isInPresentationMode) {
      return;
    }
    let newScale = this.pdfViewer.currentScale;
    do {
      newScale = (newScale / DEFAULT_SCALE_DELTA).toFixed(2);
      newScale = Math.floor(newScale * 10) / 10;
      newScale = Math.max(MIN_SCALE, newScale);
    } while (--ticks > 0 && newScale > MIN_SCALE);
    this.pdfViewer.currentScaleValue = newScale;
  },

  zoomReset() {
    if (this.pdfViewer.isInPresentationMode) {
      return;
    }
    this.pdfViewer.currentScaleValue = DEFAULT_SCALE_VALUE;
  },

  get pagesCount() {
    return this.pdfDocument ? this.pdfDocument.numPages : 0;
  },

  get page() {
    return this.pdfViewer.currentPageNumber;
  },

  set page(val) {
    this.pdfViewer.currentPageNumber = val;
  },

  get printing() {
    return !!this.printService;
  },

  get supportsPrinting() {
    return PDFPrintServiceFactory.instance.supportsPrinting;
  },

  get supportsFullscreen() {
    let support;
    if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("MOZCENTRAL")) {
      support =
        document.fullscreenEnabled === true ||
        document.mozFullScreenEnabled === true;
    } else {
      const doc = document.documentElement;
      support = !!(
        doc.requestFullscreen ||
        doc.mozRequestFullScreen ||
        doc.webkitRequestFullScreen ||
        doc.msRequestFullscreen
      );

      if (
        document.fullscreenEnabled === false ||
        document.mozFullScreenEnabled === false ||
        document.webkitFullscreenEnabled === false ||
        document.msFullscreenEnabled === false
      ) {
        support = false;
      }
    }
    return shadow(this, "supportsFullscreen", support);
  },

  get supportsIntegratedFind() {
    return this.externalServices.supportsIntegratedFind;
  },

  get supportsDocumentFonts() {
    return this.externalServices.supportsDocumentFonts;
  },

  get loadingBar() {
    const bar = new ProgressBar("#loadingBar");
    return shadow(this, "loadingBar", bar);
  },

  get supportedMouseWheelZoomModifierKeys() {
    return this.externalServices.supportedMouseWheelZoomModifierKeys;
  },

  setTitleUsingUrl(url = "") {
    this.url = url;
    this.baseUrl = url.split("#")[0];
    let title = getPDFFileNameFromURL(url, "");
    if (!title) {
      try {
        title = decodeURIComponent(getFilenameFromUrl(url)) || url;
      } catch (ex) {
        // decodeURIComponent may throw URIError,
        // fall back to using the unprocessed url in that case
        title = url;
      }
    }
    this.setTitle(title);
  },

  setTitle(title) {
    if (this.isViewerEmbedded) {
      // Embedded PDF viewers should not be changing their parent page's title.
      return;
    }
    document.title = title;
  },

  /**
   * Closes opened PDF document.
   * @returns {Promise} - Returns the promise, which is resolved when all
   *                      destruction is completed.
   */
  async close() {
    const errorWrapper = this.appConfig.errorWrapper.container;
    errorWrapper.setAttribute("hidden", "true");

    if (!this.pdfLoadingTask) {
      return undefined;
    }

    const promise = this.pdfLoadingTask.destroy();
    this.pdfLoadingTask = null;

    if (this.pdfDocument) {
      this.pdfDocument = null;

      this.pdfThumbnailViewer.setDocument(null);
      this.pdfViewer.setDocument(null);
      this.pdfLinkService.setDocument(null);
      // this.pdfDocumentProperties.setDocument(null);
    }
    webViewerResetPermissions();
    this.store = null;
    this.isInitialViewSet = false;
    this.downloadComplete = false;
    this.url = "";
    this.baseUrl = "";
    this.contentDispositionFilename = null;

    this.pdfSidebar.reset();
    this.pdfOutlineViewer.reset();
    this.pdfAttachmentViewer.reset();

    if (this.pdfHistory) {
      this.pdfHistory.reset();
    }
    if (this.findBar) {
      this.findBar.reset();
    }
    // this.toolbar.reset();
    this.secondaryToolbar.reset();

    // if (typeof PDFBug !== "undefined") {
    //   PDFBug.cleanup();
    // }
    return promise;
  },

  /**
   * Opens PDF document specified by URL or array with additional arguments.
   * @param {string|TypedArray|ArrayBuffer} file - PDF location or binary data.
   * @param {Object} [args] - Additional arguments for the getDocument call,
   *                          e.g. HTTP headers ('httpHeaders') or alternative
   *                          data transport ('range').
   * @returns {Promise} - Returns the promise, which is resolved when document
   *                      is opened.
   */
  async open(file, args) {
    if (this.pdfLoadingTask) {
      // We need to destroy already opened document.
      await this.close();
    }
    // Set the necessary global worker parameters, using the available options.
    const workerParameters = AppOptions.getAll(OptionKind.WORKER);
    for (const key in workerParameters) {
      GlobalWorkerOptions[key] = workerParameters[key];
    }

    console.log("Worker", workerParameters, GlobalWorkerOptions)

    const parameters = Object.create(null);
    if (typeof file === "string") {
      // URL
      this.setTitleUsingUrl(file);
      parameters.url = file;
    } else if (file && "byteLength" in file) {
      // ArrayBuffer
      parameters.data = file;
    } else if (file.url && file.originalUrl) {
      this.setTitleUsingUrl(file.originalUrl);
      parameters.url = file.url;
    }
    // Set the necessary API parameters, using the available options.
    const apiParameters = AppOptions.getAll(OptionKind.API);
    for (const key in apiParameters) {
      let value = apiParameters[key];

      if (key === "docBaseUrl" && !value) {
        if (typeof PDFJSDev === "undefined" || !PDFJSDev.test("PRODUCTION")) {
          value = document.URL.split("#")[0];
        } else if (PDFJSDev.test("MOZCENTRAL || CHROME")) {
          value = this.baseUrl;
        }
      }
      parameters[key] = value;
    }

    if (args) {
      for (const key in args) {
        const value = args[key];

        if (key === "length") {
          // this.pdfDocumentProperties.setFileSize(value);
        }
        parameters[key] = value;
      }
    }

    console.log("Parameters for loading", parameters);
    const loadingTask = getDocument(parameters);
    this.pdfLoadingTask = loadingTask;

    loadingTask.onPassword = (updateCallback, reason) => {
      this.pdfLinkService.externalLinkEnabled = false;
      this.passwordPrompt.setUpdateCallback(updateCallback, reason);
      this.passwordPrompt.open();
    };

    // loadingTask.onProgress = ({ loaded, total }) => {
    //   this.progress(loaded / total);
    // };

    // Listen for unsupported features to trigger the fallback UI.
    loadingTask.onUnsupportedFeature = this.fallback.bind(this);

    return loadingTask.promise.then(
      pdfDocument => {
        this.load(pdfDocument);
      },
      exception => {
        if (loadingTask !== this.pdfLoadingTask) {
          return undefined; // Ignore errors for previously opened PDF files.
        }

        const message = exception && exception.message;
        let loadingErrorMessage;

        return loadingErrorMessage.then(msg => {
          this.error(msg, {message});
          throw exception;
        });
      }
    );
  },

  download() {
    function downloadByUrl() {
      downloadManager.downloadUrl(url, filename);
    }

    const url = this.baseUrl;
    // Use this.url instead of this.baseUrl to perform filename detection based
    // on the reference fragment as ultimate fallback if needed.
    const filename =
      this.contentDispositionFilename || getPDFFileNameFromURL(this.url);
    const downloadManager = this.downloadManager;
    downloadManager.onerror = err => {
      // This error won't really be helpful because it's likely the
      // fallback won't work either (or is already open).
      this.error(`PDF failed to download: ${err}`);
    };

    // When the PDF document isn't ready, or the PDF file is still downloading,
    // simply download using the URL.
    if (!this.pdfDocument || !this.downloadComplete) {
      downloadByUrl();
      return;
    }

    this.pdfDocument
      .getData()
      .then(function (data) {
        const blob = new Blob([data], {type: "application/pdf"});
        downloadManager.download(blob, url, filename);
      })
      .catch(downloadByUrl); // Error occurred, try downloading with the URL.
  },

  fallback(featureId) {
    if (
      typeof PDFJSDev === "undefined" ||
      PDFJSDev.test("MOZCENTRAL || GENERIC")
    ) {
      // Only trigger the fallback once so we don't spam the user with messages
      // for one PDF.
      if (this.fellback) {
        return;
      }
      this.fellback = true;
      this.externalServices.fallback(
        {
          featureId,
          url: this.baseUrl,
        },
        function response(download) {
          if (!download) {
            return;
          }
          PDFViewerApplication.download();
        }
      );
    }
  },

  /**
   * Show the error box.
   * @param {string} message - A message that is human readable.
   * @param {Object} [moreInfo] - Further information about the error that is
   *                              more technical.  Should have a 'message' and
   *                              optionally a 'stack' property.
   */
  error(message, moreInfo) {
    if (typeof PDFJSDev === "undefined" || !PDFJSDev.test("MOZCENTRAL")) {
      const errorWrapperConfig = this.appConfig.errorWrapper;
      const errorWrapper = errorWrapperConfig.container;
      errorWrapper.removeAttribute("hidden");

      const errorMessage = errorWrapperConfig.errorMessage;
      errorMessage.textContent = message;

      const closeButton = errorWrapperConfig.closeButton;
      closeButton.onclick = function () {
        errorWrapper.setAttribute("hidden", "true");
      };

      const errorMoreInfo = errorWrapperConfig.errorMoreInfo;
      const moreInfoButton = errorWrapperConfig.moreInfoButton;
      const lessInfoButton = errorWrapperConfig.lessInfoButton;
      moreInfoButton.onclick = function () {
        errorMoreInfo.removeAttribute("hidden");
        moreInfoButton.setAttribute("hidden", "true");
        lessInfoButton.removeAttribute("hidden");
        errorMoreInfo.style.height = errorMoreInfo.scrollHeight + "px";
      };
      lessInfoButton.onclick = function () {
        errorMoreInfo.setAttribute("hidden", "true");
        moreInfoButton.removeAttribute("hidden");
        lessInfoButton.setAttribute("hidden", "true");
      };
      moreInfoButton.oncontextmenu = noContextMenuHandler;
      lessInfoButton.oncontextmenu = noContextMenuHandler;
      closeButton.oncontextmenu = noContextMenuHandler;
      moreInfoButton.removeAttribute("hidden");
      lessInfoButton.setAttribute("hidden", "true");
      Promise.all(moreInfoText).then(parts => {
        errorMoreInfo.value = parts.join("\n");
      });
    } else {
      Promise.all(moreInfoText).then(parts => {
        console.error(message + "\n" + parts.join("\n"));
      });
      this.fallback();
    }
  },

  progress(level) {
    if (this.downloadComplete) {
      // Don't accidentally show the loading bar again when the entire file has
      // already been fetched (only an issue when disableAutoFetch is enabled).
      return;
    }
    const percent = Math.round(level * 100);
    // When we transition from full request to range requests, it's possible
    // that we discard some of the loaded data. This can cause the loading
    // bar to move backwards. So prevent this by only updating the bar if it
    // increases.
    if (percent > this.loadingBar.percent || isNaN(percent)) {
      this.loadingBar.percent = percent;

      // When disableAutoFetch is enabled, it's not uncommon for the entire file
      // to never be fetched (depends on e.g. the file structure). In this case
      // the loading bar will not be completely filled, nor will it be hidden.
      // To prevent displaying a partially filled loading bar permanently, we
      // hide it when no data has been loaded during a certain amount of time.
      const disableAutoFetch = this.pdfDocument
        ? this.pdfDocument.loadingParams.disableAutoFetch
        : AppOptions.get("disableAutoFetch");

      if (disableAutoFetch && percent) {
        if (this.disableAutoFetchLoadingBarTimeout) {
          clearTimeout(this.disableAutoFetchLoadingBarTimeout);
          this.disableAutoFetchLoadingBarTimeout = null;
        }
        this.loadingBar.show();

        this.disableAutoFetchLoadingBarTimeout = setTimeout(() => {
          this.loadingBar.hide();
          this.disableAutoFetchLoadingBarTimeout = null;
        }, DISABLE_AUTO_FETCH_LOADING_BAR_TIMEOUT);
      }
    }
  },

  load(pdfDocument) {
    this.pdfDocument = pdfDocument;

    pdfDocument.getDownloadInfo().then(() => {
      this.downloadComplete = true;
      this.loadingBar.hide();
    });

    this.secondaryToolbar.setPagesCount(pdfDocument.numPages);

    let baseDocumentUrl;
    if (typeof PDFJSDev === "undefined" || PDFJSDev.test("GENERIC")) {
      baseDocumentUrl = null;
    } else if (PDFJSDev.test("MOZCENTRAL")) {
      baseDocumentUrl = this.baseUrl;
    } else if (PDFJSDev.test("CHROME")) {
      baseDocumentUrl = location.href.split("#")[0];
    }
    this.pdfLinkService.setDocument(pdfDocument, baseDocumentUrl);

    const pdfViewer = this.pdfViewer;
    pdfViewer.setDocument(pdfDocument);
  },
};

let validateFileURL;
if (typeof PDFJSDev === "undefined" || PDFJSDev.test("GENERIC")) {
  const HOSTED_VIEWER_ORIGINS = [
    "null",
    "http://mozilla.github.io",
    "https://mozilla.github.io",
  ];
  validateFileURL = function (file) {
    if (file === undefined) {
      return;
    }
    try {
      const viewerOrigin = new URL(window.location.href).origin || "null";
      if (HOSTED_VIEWER_ORIGINS.includes(viewerOrigin)) {
        // Hosted or local viewer, allow for any file locations
        return;
      }
      const {origin, protocol} = new URL(file, window.location.href);
      // Removing of the following line will not guarantee that the viewer will
      // start accepting URLs from foreign origin -- CORS headers on the remote
      // server must be properly configured.
      // IE10 / IE11 does not include an origin in `blob:`-URLs. So don't block
      // any blob:-URL. The browser's same-origin policy will block requests to
      // blob:-URLs from other origins, so this is safe.
      if (origin !== viewerOrigin && protocol !== "blob:") {
        throw new Error("file origin does not match viewer's");
      }
    } catch (ex) {
      const message = ex && ex.message;
      PDFViewerApplication.l10n
        .get("loading_error", null, "An error occurred while loading the PDF.")
        .then(loadingErrorMessage => {
          PDFViewerApplication.error(loadingErrorMessage, {message});
        });
      throw ex;
    }
  };
}


function webViewerInitialized() {
  let file;
  if (typeof PDFJSDev === "undefined" || PDFJSDev.test("GENERIC")) {
    const queryString = document.location.search.substring(1);
    const params = parseQueryString(queryString);
    file = "file" in params ? params.file : AppOptions.get("defaultUrl");
    validateFileURL(file);
  }

  try {
    webViewerOpenFileViaURL(file);
  } catch (reason) {
    PDFViewerApplication.l10n
      .get("loading_error", null, "An error occurred while loading the PDF.")
      .then(msg => {
        PDFViewerApplication.error(msg, reason);
      });
  }
}

let webViewerOpenFileViaURL;
if (typeof PDFJSDev === "undefined" || PDFJSDev.test("GENERIC")) {
  console.info('line 1976')
  webViewerOpenFileViaURL = function (file) {
    if (file && file.lastIndexOf("file:", 0) === 0) {
      // file:-scheme. Load the contents in the main thread because QtWebKit
      // cannot load file:-URLs in a Web Worker. file:-URLs are usually loaded
      // very quickly, so there is no need to set up progress event listeners.
      PDFViewerApplication.setTitleUsingUrl(file);
      const xhr = new XMLHttpRequest();
      xhr.onload = function () {
        PDFViewerApplication.open(new Uint8Array(xhr.response));
      };
      xhr.open("GET", file);
      xhr.responseType = "arraybuffer";
      xhr.send();
      return;
    }

    if (file) {
      PDFViewerApplication.open(file);
    }
  };
}

function webViewerResetPermissions() {
  const {appConfig} = PDFViewerApplication;
  if (!appConfig) {
    return;
  }
  // Currently only the "copy"-permission is supported.
  appConfig.viewerContainer.classList.remove(ENABLE_PERMISSIONS_CLASS);
}

/* Abstract factory for the print service. */
const PDFPrintServiceFactory = {
  instance: {
    supportsPrinting: false,
    createPrintService() {
      throw new Error("Not implemented: createPrintService");
    },
  },
};

export {
  PDFViewerApplication,
  DefaultExternalServices,
  PDFPrintServiceFactory,
};
