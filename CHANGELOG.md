# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Support for npub (bech32-encoded) public key format in admin assign endpoint
  - Accepts both 64-character hex pubkeys and npub1... format
  - Automatically normalizes to hex for storage
  - Comprehensive validation with 10 test cases

### Fixed
- TypeScript compilation errors in NIP-98 middleware and admin tests
  - Added hexToBytes helper function to convert hex strings to Uint8Arrays for @noble/secp256k1 v3.x API compatibility
  - Added type assertions for JSON responses in admin test suite

## [Previous Changes]

### Added
- NIP-05 identity verification endpoints with subdomain and root domain support
- Admin UI with React, TypeScript, and Tailwind CSS
- Static asset serving for admin interface
- Admin search endpoint with input validation
- Database queries for username management
