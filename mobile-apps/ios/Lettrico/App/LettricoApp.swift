//
//  LettricoApp.swift
//  Lettrico
//
//  Modern iOS App for Cover Letter Generation
//  Built with SwiftUI and latest design patterns
//

import SwiftUI

@main
struct LettricoApp: App {
    @StateObject private var authManager = AuthManager()
    
    var body: some Scene {
        WindowGroup {
            if authManager.isLoggedIn {
                MainTabView()
                    .environmentObject(authManager)
            } else {
                LoginView()
                    .environmentObject(authManager)
            }
        }
    }
}
