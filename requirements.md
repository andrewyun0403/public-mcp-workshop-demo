# AI Data Steward MCP Server Requirements

## 1. Functional Requirements

- Connect to a specified database using provided credentials.
- Provide a tool to retrieve the DDL (Data Definition Language) of a specified table.
- Use AI reasoning to generate a human-readable data dictionary from the DDL.
- Provide CRUD (Create, Read, Update, Delete) operations for database tables.
- Expose all tools via the MCP protocol for integration.

## 2. Non-Functional Requirements

- Securely handle and store database credentials.
- Validate and sanitize all user inputs to prevent SQL injection.
- Restrict access to authorized users only.
- Respond to requests within 2 seconds for standard operations.
- Handle concurrent requests efficiently.
- Gracefully handle database connection failures.
- Log errors and provide meaningful error messages.
- Code should be modular and well-documented.
- Support easy addition of new database types.
- Must not expose sensitive data in logs or responses.

## 3. Tool Definition: get_database_table_ddl

**Description:**  
Retrieves the DDL for a specified table and generates a human-readable data dictionary using AI reasoning.

**Inputs:**
- `database_type` (string): Type of database (e.g., PostgreSQL, MySQL, SQLite).
- `connection_info` (object): Connection parameters (host, port, username, password, database name).
- `table_name` (string): Name of the table.

**Outputs:**
- `ddl` (string): Raw DDL statement for the table.
- `data_dictionary` (string): Human-readable description of the table structure and columns.