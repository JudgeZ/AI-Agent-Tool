/* eslint-disable @typescript-eslint/no-explicit-any */
// justified: Browser automation results are dynamic - DOM elements, evaluation results,
// and page interactions return untyped objects from Puppeteer API

import {
  McpTool,
  ToolMetadata,
  ToolCapability,
  ToolContext,
  ToolResult,
} from "../McpTool";
import { SandboxType, SandboxCapabilities } from "../../sandbox";
import { z } from "zod";
import puppeteer, { Browser, Page } from "puppeteer";
import type { LaunchOptions } from "puppeteer";
import { Logger } from "pino";

// ============================================================================
// Input/Output Schemas
// ============================================================================

const NavigateInputSchema = z.object({
  url: z.string().url(),
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
    .default("networkidle2"),
  timeout: z.number().min(1000).max(60000).default(30000),
});

const ClickInputSchema = z.object({
  selector: z.string(),
  waitForNavigation: z.boolean().default(false),
  timeout: z.number().min(100).max(30000).default(5000),
});

const TypeInputSchema = z.object({
  selector: z.string(),
  text: z.string(),
  delay: z.number().min(0).max(1000).default(0), // Delay between keystrokes
  clearFirst: z.boolean().default(false),
});

const ScreenshotInputSchema = z.object({
  fullPage: z.boolean().default(false),
  type: z.enum(["png", "jpeg", "webp"]).default("png"),
  quality: z.number().min(0).max(100).optional(), // For JPEG/WebP
  clip: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

const ExtractInputSchema = z.object({
  selector: z.string(),
  attribute: z.string().optional(), // Extract specific attribute, otherwise text content
  multiple: z.boolean().default(false), // Extract from all matching elements
});

const EvaluateInputSchema = z.object({
  script: z.string(), // JavaScript code to execute
  args: z.array(z.any()).optional(), // Arguments to pass to script
});

const WaitForInputSchema = z.object({
  type: z.enum(["selector", "xpath", "function", "timeout"]),
  value: z.union([z.string(), z.number()]),
  timeout: z.number().min(100).max(60000).default(30000),
});

const FormFillInputSchema = z.object({
  fields: z.array(
    z.object({
      selector: z.string(),
      value: z.string(),
      type: z.enum(["text", "select", "checkbox", "radio"]).default("text"),
    }),
  ),
});

export type NavigateInput = z.infer<typeof NavigateInputSchema>;
export type ClickInput = z.infer<typeof ClickInputSchema>;
export type TypeInput = z.infer<typeof TypeInputSchema>;
export type ScreenshotInput = z.infer<typeof ScreenshotInputSchema>;
export type ExtractInput = z.infer<typeof ExtractInputSchema>;
export type EvaluateInput = z.infer<typeof EvaluateInputSchema>;
export type WaitForInput = z.infer<typeof WaitForInputSchema>;
export type FormFillInput = z.infer<typeof FormFillInputSchema>;

export interface NavigateOutput {
  url: string;
  title: string;
  statusCode: number;
  loadTime: number;
}

export interface ClickOutput {
  clicked: boolean;
  navigated: boolean;
  newUrl?: string;
}

export interface TypeOutput {
  typed: boolean;
  charactersTyped: number;
}

export interface ScreenshotOutput {
  data: string; // Base64 encoded image
  width: number;
  height: number;
  format: string;
}

export interface ExtractOutput {
  value: string | string[];
  count: number;
}

export interface EvaluateOutput {
  result: any;
  type: string;
}

export interface WaitForOutput {
  waited: boolean;
  duration: number;
}

export interface FormFillOutput {
  fieldsFilled: number;
  success: boolean;
}

// ============================================================================
// Browser Tool Configuration
// ============================================================================

export interface BrowserToolConfig {
  headless: boolean;
  defaultTimeout: number;
  slowMo: number; // Slow down operations by N milliseconds
  viewport: {
    width: number;
    height: number;
  };
  userAgent?: string;
  blockedResourceTypes: string[]; // Block images, stylesheets, etc. for performance
  allowedDomains?: string[]; // Whitelist of allowed domains
  maxPages: number; // Maximum concurrent pages
  devtools: boolean;
  executablePath?: string;
}

const DEFAULT_CONFIG: BrowserToolConfig = {
  headless: true,
  defaultTimeout: 30000,
  slowMo: 0,
  viewport: {
    width: 1920,
    height: 1080,
  },
  blockedResourceTypes: [],
  maxPages: 5,
  devtools: false,
};

// ============================================================================
// Browser Tool Implementation
// ============================================================================

export class BrowserTool extends McpTool<any, any> {
  private browser: Browser | null = null;
  private pages: Map<string, Page> = new Map();
  private config: BrowserToolConfig;

  constructor(logger: Logger, config: Partial<BrowserToolConfig> = {}) {
    const metadata: ToolMetadata = {
      id: "browser",
      name: "Browser Automation Tool",
      description:
        "Automates browser interactions using Puppeteer for web scraping and testing",
      version: "1.0.0",
      capabilities: [
        ToolCapability.NETWORK_ACCESS,
        ToolCapability.BROWSER_AUTOMATION,
        ToolCapability.SCREENSHOT,
      ],
      requiresApproval: true, // Browser automation can access external resources
      sandboxType: SandboxType.CONTAINER,
      sandboxCapabilities: {
        network: true,
        filesystem: false,
        heavyCompute: false,
        externalBinaries: true, // Puppeteer needs Chrome/Chromium
      },
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "navigate",
              "click",
              "type",
              "screenshot",
              "extract",
              "evaluate",
              "waitFor",
              "formFill",
            ],
          },
          params: { type: "object" },
          pageId: { type: "string" },
        },
        required: ["operation", "params"],
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: { type: "object" },
        },
      },
    };

    super(metadata, logger);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================================================
  // Tool Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    const launchOptions: LaunchOptions = {
      headless: this.config.headless,
      slowMo: this.config.slowMo,
      devtools: this.config.devtools,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    };

    if (this.config.executablePath) {
      launchOptions.executablePath = this.config.executablePath;
    }

    this.browser = await puppeteer.launch(launchOptions);
    this.emit("initialized", {
      tool: this.metadata.id,
      browserVersion: await this.browser.version(),
    });
  }

  async shutdown(): Promise<void> {
    // Close all pages
    for (const [pageId, page] of this.pages) {
      await page.close().catch(() => {});
    }
    this.pages.clear();

    // Close browser
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    this.emit("shutdown", { tool: this.metadata.id });
  }

  // ============================================================================
  // Main Execution Entry Point
  // ============================================================================

  protected async executeImpl(input: any, context: ToolContext): Promise<any> {
    if (!this.browser) {
      throw new Error("Browser not initialized. Call initialize() first.");
    }

    const { operation, params, pageId = "default" } = input;

    // Get or create page
    let page = this.pages.get(pageId);
    if (!page) {
      if (this.pages.size >= this.config.maxPages) {
        throw new Error(
          `Maximum number of pages (${this.config.maxPages}) reached`,
        );
      }
      page = await this.createPage(pageId);
    }

    switch (operation) {
      case "navigate":
        return await this.navigate(page, params);
      case "click":
        return await this.click(page, params);
      case "type":
        return await this.type(page, params);
      case "screenshot":
        return await this.screenshot(page, params);
      case "extract":
        return await this.extract(page, params);
      case "evaluate":
        return await this.evaluate(page, params);
      case "waitFor":
        return await this.waitFor(page, params);
      case "formFill":
        return await this.formFill(page, params);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  protected async validateInput(input: any): Promise<void> {
    if (!input.operation || !input.params) {
      throw new Error("Invalid input: operation and params are required");
    }
  }

  // ============================================================================
  // Page Management
  // ============================================================================

  private async createPage(pageId: string): Promise<Page> {
    if (!this.browser) {
      throw new Error("Browser not initialized");
    }

    const page = await this.browser.newPage();

    // Set viewport
    await page.setViewport(this.config.viewport);

    // Set user agent if configured
    if (this.config.userAgent) {
      await page.setUserAgent(this.config.userAgent);
    }

    // Set default timeout
    page.setDefaultTimeout(this.config.defaultTimeout);

    // Block resource types if configured
    if (this.config.blockedResourceTypes.length > 0) {
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        if (this.config.blockedResourceTypes.includes(request.resourceType())) {
          request.abort();
        } else {
          request.continue();
        }
      });
    }

    // Domain whitelist check
    if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (!this.config.allowedDomains!.includes(url.hostname)) {
          this.emit("domain:blocked", {
            url: request.url(),
            hostname: url.hostname,
          });
          request.abort();
        }
      });
    }

    // Console logging
    page.on("console", (msg) => {
      this.emit("console", { type: msg.type(), text: msg.text(), pageId });
    });

    // Error handling
    page.on("pageerror", (error: unknown) => {
      const err = error as Error;
      this.emit("page:error", { error: err.message, pageId });
    });

    this.pages.set(pageId, page);
    this.emit("page:created", { pageId });

    return page;
  }

  // ============================================================================
  // Navigate
  // ============================================================================

  private async navigate(page: Page, params: unknown): Promise<NavigateOutput> {
    const input = NavigateInputSchema.parse(params);

    // Check allowed domains
    if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
      const url = new URL(input.url);
      if (!this.config.allowedDomains.includes(url.hostname)) {
        throw new Error(`Domain ${url.hostname} is not in allowed list`);
      }
    }

    this.emit("navigate:started", { url: input.url });

    const startTime = Date.now();
    const response = await page.goto(input.url, {
      waitUntil: input.waitUntil,
      timeout: input.timeout,
    });

    if (!response) {
      throw new Error("Navigation failed: no response");
    }

    const loadTime = Date.now() - startTime;
    const title = await page.title();
    const url = page.url();

    const output: NavigateOutput = {
      url,
      title,
      statusCode: response.status(),
      loadTime,
    };

    this.emit("navigate:completed", output);
    return output;
  }

  // ============================================================================
  // Click
  // ============================================================================

  private async click(page: Page, params: unknown): Promise<ClickOutput> {
    const input = ClickInputSchema.parse(params);

    this.emit("click:started", { selector: input.selector });

    // Wait for element
    await page.waitForSelector(input.selector, { timeout: input.timeout });

    const currentUrl = page.url();

    if (input.waitForNavigation) {
      await Promise.all([
        page.waitForNavigation({ timeout: input.timeout }),
        page.click(input.selector),
      ]);

      const newUrl = page.url();
      const navigated = newUrl !== currentUrl;

      this.emit("click:completed", { selector: input.selector, navigated });

      return {
        clicked: true,
        navigated,
        newUrl: navigated ? newUrl : undefined,
      };
    } else {
      await page.click(input.selector);

      this.emit("click:completed", {
        selector: input.selector,
        navigated: false,
      });

      return {
        clicked: true,
        navigated: false,
      };
    }
  }

  // ============================================================================
  // Type
  // ============================================================================

  private async type(page: Page, params: unknown): Promise<TypeOutput> {
    const input = TypeInputSchema.parse(params);

    this.emit("type:started", {
      selector: input.selector,
      length: input.text.length,
    });

    // Wait for element
    await page.waitForSelector(input.selector);

    // Clear field if requested
    if (input.clearFirst) {
      await page.click(input.selector, { clickCount: 3 }); // Triple-click to select all
      await page.keyboard.press("Backspace");
    }

    // Type text
    await page.type(input.selector, input.text, { delay: input.delay });

    this.emit("type:completed", {
      selector: input.selector,
      charactersTyped: input.text.length,
    });

    return {
      typed: true,
      charactersTyped: input.text.length,
    };
  }

  // ============================================================================
  // Screenshot
  // ============================================================================

  private async screenshot(
    page: Page,
    params: unknown,
  ): Promise<ScreenshotOutput> {
    const input = ScreenshotInputSchema.parse(params);

    this.emit("screenshot:started", { fullPage: input.fullPage });

    const options: any = {
      type: input.type,
      fullPage: input.fullPage,
      encoding: "base64",
    };

    if (input.quality && (input.type === "jpeg" || input.type === "webp")) {
      options.quality = input.quality;
    }

    if (input.clip) {
      options.clip = input.clip;
    }

    const screenshot = await page.screenshot(options);
    const data = screenshot.toString();

    // Get dimensions
    let width = this.config.viewport.width;
    let height = this.config.viewport.height;

    if (input.clip) {
      width = input.clip.width;
      height = input.clip.height;
    } else if (input.fullPage) {
      const metrics = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      }));
      width = metrics.width;
      height = metrics.height;
    }

    const output: ScreenshotOutput = {
      data,
      width,
      height,
      format: input.type,
    };

    this.emit("screenshot:completed", {
      size: data.length,
      format: input.type,
    });

    return output;
  }

  // ============================================================================
  // Extract
  // ============================================================================

  private async extract(page: Page, params: unknown): Promise<ExtractOutput> {
    const input = ExtractInputSchema.parse(params);

    this.emit("extract:started", {
      selector: input.selector,
      attribute: input.attribute,
    });

    if (input.multiple) {
      // Extract from all matching elements
      const values = await page.$$eval(
        input.selector,
        (elements, attribute) => {
          return elements.map((el) =>
            attribute
              ? el.getAttribute(attribute) || ""
              : el.textContent?.trim() || "",
          );
        },
        input.attribute,
      );

      this.emit("extract:completed", { count: values.length });

      return {
        value: values,
        count: values.length,
      };
    } else {
      // Extract from first matching element
      const value = await page.$eval(
        input.selector,
        (element, attribute) => {
          return attribute
            ? element.getAttribute(attribute) || ""
            : element.textContent?.trim() || "";
        },
        input.attribute,
      );

      this.emit("extract:completed", { count: 1 });

      return {
        value,
        count: 1,
      };
    }
  }

  // ============================================================================
  // Evaluate
  // ============================================================================

  private async evaluate(page: Page, params: unknown): Promise<EvaluateOutput> {
    const input = EvaluateInputSchema.parse(params);

    this.emit("evaluate:started", { scriptLength: input.script.length });

    // Execute script in page context
    const result = input.args
      ? await page.evaluate(
          new Function(
            ...input.args.map((_, i) => `arg${i}`),
            input.script,
          ) as any,
          ...input.args,
        )
      : await page.evaluate(input.script);

    this.emit("evaluate:completed", { resultType: typeof result });

    return {
      result,
      type: typeof result,
    };
  }

  // ============================================================================
  // Wait For
  // ============================================================================

  private async waitFor(page: Page, params: unknown): Promise<WaitForOutput> {
    const input = WaitForInputSchema.parse(params);

    this.emit("waitFor:started", { type: input.type, value: input.value });

    const startTime = Date.now();

    switch (input.type) {
      case "selector":
        await page.waitForSelector(input.value as string, {
          timeout: input.timeout,
        });
        break;

      case "xpath":
        await page.waitForSelector(`::-p-xpath(${input.value})`, {
          timeout: input.timeout,
        });
        break;

      case "function":
        await page.waitForFunction(input.value as string, {
          timeout: input.timeout,
        });
        break;

      case "timeout":
        await new Promise((resolve) =>
          setTimeout(resolve, input.value as number),
        );
        break;

      default:
        throw new Error(`Unknown wait type: ${input.type}`);
    }

    const duration = Date.now() - startTime;

    this.emit("waitFor:completed", { type: input.type, duration });

    return {
      waited: true,
      duration,
    };
  }

  // ============================================================================
  // Form Fill
  // ============================================================================

  private async formFill(page: Page, params: unknown): Promise<FormFillOutput> {
    const input = FormFillInputSchema.parse(params);

    this.emit("formFill:started", { fields: input.fields.length });

    let fieldsFilled = 0;

    for (const field of input.fields) {
      await page.waitForSelector(field.selector);

      switch (field.type) {
        case "text":
          await page.type(field.selector, field.value);
          break;

        case "select":
          await page.select(field.selector, field.value);
          break;

        case "checkbox":
        case "radio": {
          const isChecked = await page.$eval(
            field.selector,
            (el: any) => el.checked,
          );
          const shouldCheck =
            field.value === "true" ||
            field.value === "1" ||
            field.value === "yes";

          if (isChecked !== shouldCheck) {
            await page.click(field.selector);
          }
          break;
        }

        default:
          throw new Error(`Unknown field type: ${field.type}`);
      }

      fieldsFilled++;
    }

    this.emit("formFill:completed", { fieldsFilled });

    return {
      fieldsFilled,
      success: true,
    };
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  public async closePage(pageId: string): Promise<void> {
    const page = this.pages.get(pageId);
    if (page) {
      await page.close();
      this.pages.delete(pageId);
      this.emit("page:closed", { pageId });
    }
  }

  public async getPageIds(): Promise<string[]> {
    return Array.from(this.pages.keys());
  }

  public async getCurrentUrl(
    pageId: string = "default",
  ): Promise<string | null> {
    const page = this.pages.get(pageId);
    return page ? page.url() : null;
  }

  public async getPageTitle(
    pageId: string = "default",
  ): Promise<string | null> {
    const page = this.pages.get(pageId);
    return page ? await page.title() : null;
  }
}
