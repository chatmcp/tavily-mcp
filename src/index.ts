#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema, Tool} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getParamValue, getAuthValue } from "@chatmcp/sdk/utils/index.js";
import { RestServerTransport } from "@chatmcp/sdk/server/rest.js";

dotenv.config();

// const API_KEY = process.env.TAVILY_API_KEY;
// if (!API_KEY) {
//   throw new Error("TAVILY_API_KEY environment variable is required");
// }

const tavilyApiKey = getParamValue("tavily_api_key") || "";
 
const mode = getParamValue("mode") || "stdio";
const port = getParamValue("port") || 9593;
const endpoint = getParamValue("endpoint") || "/rest";

interface TavilyResponse {
  // Response structure from Tavily API
  query: string;
  follow_up_questions?: Array<string>;
  answer?: string;
  images?: Array<string | {
    url: string;
    description?: string;
  }>;
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
    raw_content?: string;
  }>;
}

class TavilyClient {
  // Core client properties
  private server: Server;
  private axiosInstance;
  private baseURLs = {
    search: 'https://api.tavily.com/search',
    extract: 'https://api.tavily.com/extract'
  };

  constructor() {
    this.server = new Server(
      {
        name: "tavily-mcp",
        version: "0.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
          prompts: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        // 'x-api-key': apiKey
      }
    });

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Define available tools: tavily-search and tavily-extract
      const tools: Tool[] = [
        {
          name: "tavily-search",
          description: "A powerful web search tool that provides comprehensive, real-time results using Tavily's AI search engine. Returns relevant web content with customizable parameters for result count, content type, and domain filtering. Ideal for gathering current information, news, and detailed web content analysis.",
          inputSchema: {
            type: "object",
            properties: {
              query: { 
                type: "string", 
                description: "Search query" 
              },
              search_depth: {
                type: "string",
                enum: ["basic","advanced"],
                description: "The depth of the search. It can be 'basic' or 'advanced'",
                default: "basic"
              },
              topic : {
                type: "string",
                enum: ["general","news"],
                description: "The category of the search. This will determine which of our agents will be used for the search",
                default: "general"
              },
              days: {
                type: "number",
                description: "The number of days back from the current date to include in the search results. This specifies the time frame of data to be retrieved. Please note that this feature is only available when using the 'news' search topic",
                default: 3
              },
              time_range: {
                type: "string",
                description: "The time range back from the current date to include in the search results. This feature is available for both 'general' and 'news' search topics",
                enum: ["day", "week", "month", "year", "d", "w", "m", "y"],
              },
              max_results: { 
                type: "number", 
                description: "The maximum number of search results to return",
                default: 10,
                minimum: 5,
                maximum: 20
              },
              include_images: { 
                type: "boolean", 
                description: "Include a list of query-related images in the response",
                default: false,
              },
              include_image_descriptions: { 
                type: "boolean", 
                description: "Include a list of query-related images and their descriptions in the response",
                default: false,
              },
              /*
              // Since the mcp server is using claude to generate answers form the search results, we don't need to include this feature.
              include_answer: { 
                type: ["boolean", "string"],
                enum: [true, false, "basic", "advanced"],
                description: "Include an answer to original query, generated by an LLM based on Tavily's search results. Can be boolean or string ('basic'/'advanced'). 'basic'/true answer will be quick but less detailed, 'advanced' answer will be more detailed but take longer to generate",
                default: false,
              },
              */
              include_raw_content: { 
                type: "boolean", 
                description: "Include the cleaned and parsed HTML content of each search result",
                default: false,
              },
              include_domains: {
                type: "array",
                items: { type: "string" },
                description: "A list of domains to specifically include in the search results, if the user asks to search on specific sites set this to the domain of the site",
                default: []
              },
              exclude_domains: {
                type: "array",
                items: { type: "string" },
                description: "List of domains to specifically exclude, if the user asks to exclude a domain set this to the domain of the site",
                default: []
              }
            },
            required: ["query"]
          }
        },
        {
          name: "tavily-extract",
          description: "A powerful web content extraction tool that retrieves and processes raw content from specified URLs, ideal for data collection, content analysis, and research tasks.",
          inputSchema: {
            type: "object",
            properties: {
              urls: { 
                type: "array",
                items: { type: "string" },
                description: "List of URLs to extract content from"
              },
              extract_depth: { 
                type: "string",
                enum: ["basic","advanced"],
                description: "Depth of extraction - 'basic' or 'advanced', if usrls are linkedin use 'advanced' or if explicitly told to use advanced",
                default: "basic"
              },
              include_images: { 
                type: "boolean", 
                description: "Include a list of images extracted from the urls in the response",
                default: false,
              }
            },
            required: ["urls"]
          }
        },
      ];
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const apiKey = getAuthValue(request, "TAVILY_API_KEY") || tavilyApiKey;
        if (!apiKey) {
          throw new Error("TAVILY_API_KEY not set");
        }

        let response: TavilyResponse;
        const args = request.params.arguments ?? {};

        switch (request.params.name) {
          case "tavily-search":
            response = await this.search(apiKey, {
              query: args.query,
              search_depth: args.search_depth,
              topic: args.topic,
              days: args.days,
              time_range: args.time_range,
              max_results: args.max_results,
              include_images: args.include_images,
              include_image_descriptions: args.include_image_descriptions,
              include_raw_content: args.include_raw_content,
              include_domains: Array.isArray(args.include_domains) ? args.include_domains : [],
              exclude_domains: Array.isArray(args.exclude_domains) ? args.exclude_domains : []
            });
            break;
          
          case "tavily-extract":
            response = await this.extract(apiKey, {
              urls: args.urls,
              extract_depth: args.extract_depth,
              include_images: args.include_images
            });
            break;

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }

        return {
          content: [{
            type: "text",
            text: formatResults(response)
          }]
        };
      } catch (error: any) {
        if (axios.isAxiosError(error)) {
          return {
            content: [{
              type: "text",
              text: `Tavily API error: ${error.response?.data?.message ?? error.message}`
            }],
            isError: true,
          }
        }
        throw error;
      }
    });
  }


  async run(): Promise<void> {
    if (mode === "rest") {
      const transport = new RestServerTransport({
        port,
        endpoint,
      });
      await this.server.connect(transport);
 
      await transport.startServer();
 
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Tavily MCP server running on stdio");
  }

  async search(apiKey: string, params: any): Promise<TavilyResponse> {
    try {
      // Choose endpoint based on whether it's an extract request
      const endpoint = params.url ? this.baseURLs.extract : this.baseURLs.search;
      
      // Add topic: "news" if query contains the word "news"
      const searchParams = {
        ...params,
        api_key: apiKey,
        topic: params.query.toLowerCase().includes('news') ? 'news' : undefined
      };

      this.axiosInstance.defaults.headers.common['x-api-key'] = apiKey;

      const response = await this.axiosInstance.post(endpoint, searchParams);
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Invalid API key');
      } else if (error.response?.status === 429) {
        throw new Error('Usage limit exceeded');
      }
      throw error;
    }
  }

  async extract(apiKey: string, params: any): Promise<TavilyResponse> {
    try {
      this.axiosInstance.defaults.headers.common['x-api-key'] = apiKey;

      const response = await this.axiosInstance.post(this.baseURLs.extract, {
        ...params,
        api_key: apiKey
      });
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Invalid API key');
      } else if (error.response?.status === 429) {
        throw new Error('Usage limit exceeded');
      }
      throw error;
    }
  }
}

function formatResults(response: TavilyResponse): string {
  // Format API response into human-readable text
  const output: string[] = [];

  // Include answer if available
  if (response.answer) {
    output.push(`Answer: ${response.answer}`);
    output.push('\nSources:');
    response.results.forEach(result => {
      output.push(`- ${result.title}: ${result.url}`);
    });
    output.push('');
  }

  // Format detailed search results
  output.push('Detailed Results:');
  response.results.forEach(result => {
    output.push(`\nTitle: ${result.title}`);
    output.push(`URL: ${result.url}`);
    output.push(`Content: ${result.content}`);
    if (result.raw_content) {
      output.push(`Raw Content: ${result.raw_content}`);
    }
  });

  return output.join('\n');
}

export async function serve(): Promise<void> {
  const client = new TavilyClient();
  await client.run();
}

const server = new TavilyClient();
server.run().catch(console.error);