package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// SearchRequest represents incoming query from Tauri
type SearchRequest struct {
	Query string `json:"query"`
}

// SearchResult represents a single file match returned to Tauri
type SearchResult struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"` // "file" or "directory"
}

// ResponseEnvelope represents the JSON sent back to Tauri stdout
type ResponseEnvelope struct {
	Status  string         `json:"status"`
	Results []SearchResult `json:"results"`
	Error   string         `json:"error,omitempty"`
}

func main() {
	log.Println("🚀 Better Search backend started successfully!")
	log.Println("Waiting for queries on Stdin...")

	// Handle graceful shutdown signals (Ctrl+C / SIGTERM)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Println("👋 Shutting down backend cleanly...")
		os.Exit(0)
	}()

	// Read input from Stdin (sent by Tauri IPC)
	scanner := bufio.NewScanner(os.Stdin)

	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}

		var req SearchRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			sendError(fmt.Sprintf("Failed to parse request: %v", err))
			continue
		}

		// Initial response — backend search engine logic will process queries here
		results := []SearchResult{
			{
				Name: "Demo File.txt",
				Path: "C:\\Users\\Public\\Demo File.txt",
				Type: "file",
			},
		}

		sendSuccess(results)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("Error reading stdin: %v\n", err)
	}

	log.Println("👋 Stdin closed. Shutting down backend...")
}

func sendSuccess(results []SearchResult) {
	resp := ResponseEnvelope{
		Status:  "ok",
		Results: results,
	}
	data, _ := json.Marshal(resp)
	fmt.Println(string(data))
}

func sendError(msg string) {
	resp := ResponseEnvelope{
		Status: "error",
		Error:  msg,
	}
	data, _ := json.Marshal(resp)
	fmt.Println(string(data))
}
