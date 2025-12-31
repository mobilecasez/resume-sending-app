//
//  APIClient.swift
//  Lettrico
//
//  API client for communicating with backend
//

import Foundation

class APIClient {
    static let shared = APIClient()
    private let baseURL = "http://localhost:3000"
    
    func login(email: String, password: String) async throws -> AuthResponse {
        let endpoint = "\(baseURL)/api/auth/login"
        let body: [String: String] = [
            "email": email,
            "password": password
        ]
        
        return try await makeRequest(endpoint: endpoint, method: "POST", body: body)
    }
    
    func register(fullName: String, email: String, password: String) async throws -> AuthResponse {
        let endpoint = "\(baseURL)/api/auth/register"
        let body: [String: String] = [
            "fullName": fullName,
            "email": email,
            "password": password
        ]
        
        return try await makeRequest(endpoint: endpoint, method: "POST", body: body)
    }
    
    func generateCoverLetter(
        userId: Int,
        companyName: String,
        position: String,
        websiteUrl: String,
        recipientEmail: String,
        token: String
    ) async throws -> [String: Any] {
        let endpoint = "\(baseURL)/api/cover-letter/generate"
        let body: [String: Any] = [
            "userId": userId,
            "companyName": companyName,
            "position": position,
            "websiteUrl": websiteUrl,
            "recipientEmail": recipientEmail
        ]
        
        return try await makeRequest(
            endpoint: endpoint,
            method: "POST",
            body: body,
            token: token
        ) as? [String: Any] ?? [:]
    }
    
    func getUserProfile(token: String) async throws -> User {
        let endpoint = "\(baseURL)/api/user/profile"
        return try await makeRequest(endpoint: endpoint, method: "GET", token: token)
    }
    
    func updateUserProfile(user: User, token: String) async throws -> User {
        let endpoint = "\(baseURL)/api/user/profile"
        return try await makeRequest(endpoint: endpoint, method: "PUT", body: user, token: token)
    }
    
    private func makeRequest<T: Decodable>(
        endpoint: String,
        method: String,
        body: Encodable? = nil,
        token: String? = nil
    ) async throws -> T {
        guard let url = URL(string: endpoint) else {
            throw URLError(.badURL)
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if let token = token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        if let body = body {
            request.httpBody = try JSONEncoder().encode(body)
        }
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
        
        return try JSONDecoder().decode(T.self, from: data)
    }
}
