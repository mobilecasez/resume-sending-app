//
//  AuthManager.swift
//  Lettrico
//
//  Authentication manager for handling user sessions
//

import Foundation

class AuthManager: ObservableObject {
    @Published var isLoggedIn = false
    @Published var currentUser: User?
    @Published var authToken: String?
    @Published var errorMessage: String?
    
    private let keychainService = KeychainService()
    
    init() {
        // Try to load saved session
        if let savedToken = keychainService.retrieve(key: "authToken"),
           let savedUserData = UserDefaults.standard.data(forKey: "currentUser"),
           let user = try? JSONDecoder().decode(User.self, from: savedUserData) {
            self.authToken = savedToken
            self.currentUser = user
            self.isLoggedIn = true
        }
    }
    
    func login(email: String, password: String) async {
        do {
            let response = try await APIClient.shared.login(email: email, password: password)
            
            DispatchQueue.main.async {
                self.authToken = response.token
                self.currentUser = response.user
                self.isLoggedIn = true
                self.errorMessage = nil
                
                // Save to keychain and UserDefaults
                self.keychainService.save(key: "authToken", value: response.token)
                if let userData = try? JSONEncoder().encode(response.user) {
                    UserDefaults.standard.set(userData, forKey: "currentUser")
                }
            }
        } catch {
            DispatchQueue.main.async {
                self.errorMessage = "Login failed: \(error.localizedDescription)"
            }
        }
    }
    
    func register(fullName: String, email: String, password: String) async {
        do {
            let response = try await APIClient.shared.register(fullName: fullName, email: email, password: password)
            
            DispatchQueue.main.async {
                self.authToken = response.token
                self.currentUser = response.user
                self.isLoggedIn = true
                self.errorMessage = nil
                
                self.keychainService.save(key: "authToken", value: response.token)
                if let userData = try? JSONEncoder().encode(response.user) {
                    UserDefaults.standard.set(userData, forKey: "currentUser")
                }
            }
        } catch {
            DispatchQueue.main.async {
                self.errorMessage = "Registration failed: \(error.localizedDescription)"
            }
        }
    }
    
    func logout() {
        authToken = nil
        currentUser = nil
        isLoggedIn = false
        keychainService.delete(key: "authToken")
        UserDefaults.standard.removeObject(forKey: "currentUser")
    }
}

// Keychain service for secure token storage
class KeychainService {
    func save(key: String, value: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecValueData as String: value.data(using: .utf8) ?? Data()
        ]
        SecItemDelete(query as CFDictionary)
        SecItemAdd(query as CFDictionary, nil)
    }
    
    func retrieve(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true
        ]
        
        var result: AnyObject?
        SecItemCopyMatching(query as CFDictionary, &result)
        
        if let data = result as? Data {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }
    
    func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }
}
