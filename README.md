# MediaMicroservice

# Media Processing Worker (Node.js)

## Overview
This repository contains a **Node.js CLI-based worker microservice** designed for **media ingestion, metadata extraction, and cross-site media linking**.  
It is intended to run as a **scheduled / cron job**, not as an HTTP API.

The service processes video files and images stored on disk, keeps database records synchronized, and enables media reuse across sites using filesystem-level optimizations.

> This is a sanitized portfolio version. All proprietary configuration, credentials, and internal identifiers have been removed.

---

## What It Does
- Scans filesystem directories for media assets (movies, samples, images)
- Extracts technical metadata using **ffmpeg / ffprobe**
- Inserts and updates records using **Sequelize ORM**
- Automatically detects deleted or modified files
- Updates movie duration, resolution, codec, and status
- Links media across sites using **symbolic links**
- Copies image assets where symlinks are not appropriate
- Safe to re-run (idempotent, batch-based processing)

---

## Architecture
Filesystem (Movies / Samples / Images)
→ MediaInfo Worker (metadata extraction, DB sync)
→ Database (movies, thumbnails, mappings)
→ MediaLinker Worker (symlinks, image copy)

---

## Tech Stack
- Node.js
- Sequelize ORM
- PostgreSQL / MySQL
- ffmpeg / ffprobe
- Filesystem APIs (fs)
- Commander (CLI argument parsing)

---

## Design Notes
- Worker-style microservice (not Express, not NestJS)
- Stateless, configuration-driven execution
- Transaction-safe database updates
- Batch processing for large datasets
- Graceful handling of partial failures
- Built for real production cron environments

---

## Use Cases
- Automated media ingestion pipelines
- Media metadata auditing
- Detecting removed or replaced assets
- Cross-site media reuse
- Storage optimization via symlinks

---

## Notes for Reviewers
This repository focuses on **backend engineering patterns** and **production-grade batch processing**.  
Business-specific logic and configuration have been intentionally excluded.




