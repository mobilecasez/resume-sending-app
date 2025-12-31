//
//  MainTabView.swift
//  Lettrico
//
//  Main tab-based navigation after login
//

import SwiftUI

struct MainTabView: View {
    @EnvironmentObject var authManager: AuthManager
    
    var body: some View {
        TabView {
            // Dashboard
            DashboardView()
                .tabItem {
                    Label("Dashboard", systemImage: "house.fill")
                }
            
            // Generate Cover Letter
            GenerateCoverLetterView()
                .tabItem {
                    Label("Generate", systemImage: "doc.text.fill")
                }
            
            // Profile
            ProfileView()
                .tabItem {
                    Label("Profile", systemImage: "person.fill")
                }
            
            // Settings
            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
        .tint(Color(red: 0.12, green: 0.25, blue: 0.69))
    }
}

// MARK: - Dashboard View
struct DashboardView: View {
    @EnvironmentObject var authManager: AuthManager
    
    var body: some View {
        NavigationView {
            VStack {
                Text("Welcome, \(authManager.currentUser?.fullName ?? "User")")
                    .font(.title2)
                    .fontWeight(.bold)
                    .padding()
                
                VStack(spacing: 16) {
                    DashboardCard(title: "Generated", count: "0", icon: "doc.text")
                    DashboardCard(title: "Sent", count: "0", icon: "paperplane")
                    DashboardCard(title: "Companies", count: "0", icon: "building.2")
                }
                .padding()
                
                Spacer()
            }
            .navigationTitle("Dashboard")
        }
    }
}

struct DashboardCard: View {
    let title: String
    let count: String
    let icon: String
    
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.subheadline)
                    .foregroundColor(.gray)
                
                Text(count)
                    .font(.title3)
                    .fontWeight(.bold)
            }
            
            Spacer()
            
            Image(systemName: icon)
                .font(.title2)
                .foregroundColor(.blue)
        }
        .padding(16)
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }
}

// MARK: - Generate Cover Letter View
struct GenerateCoverLetterView: View {
    @State private var companyName = ""
    @State private var position = ""
    @State private var websiteUrl = ""
    @State private var recipientEmail = ""
    @State private var isLoading = false
    
    var body: some View {
        NavigationView {
            Form {
                Section("Company Information") {
                    TextField("Company Name", text: $companyName)
                    TextField("Position", text: $position)
                    TextField("Website URL", text: $websiteUrl)
                        .keyboardType(.URL)
                }
                
                Section("Recipient") {
                    TextField("Email Address", text: $recipientEmail)
                        .keyboardType(.emailAddress)
                }
                
                Section {
                    Button(action: {}) {
                        if isLoading {
                            ProgressView()
                        } else {
                            Text("Generate Cover Letter")
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color(red: 0.12, green: 0.25, blue: 0.69))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .disabled(isLoading)
                }
            }
            .navigationTitle("Generate")
        }
    }
}

// MARK: - Profile View
struct ProfileView: View {
    @EnvironmentObject var authManager: AuthManager
    @State private var isEditing = false
    
    var body: some View {
        NavigationView {
            VStack {
                Form {
                    Section("Personal Information") {
                        if let user = authManager.currentUser {
                            TextField("Full Name", text: .constant(user.fullName))
                                .disabled(!isEditing)
                            
                            TextField("Email", text: .constant(user.email))
                                .disabled(!isEditing)
                            
                            if let phone = user.phone {
                                TextField("Phone", text: .constant(phone))
                                    .disabled(!isEditing)
                            }
                        }
                    }
                    
                    Section {
                        Button(isEditing ? "Save Changes" : "Edit Profile") {
                            isEditing.toggle()
                        }
                        .frame(maxWidth: .infinity)
                        .foregroundColor(.blue)
                    }
                }
            }
            .navigationTitle("Profile")
        }
    }
}

// MARK: - Settings View
struct SettingsView: View {
    @EnvironmentObject var authManager: AuthManager
    
    var body: some View {
        NavigationView {
            VStack {
                Form {
                    Section("Preferences") {
                        Toggle("Notifications", isOn: .constant(true))
                        Toggle("Dark Mode", isOn: .constant(false))
                    }
                    
                    Section {
                        Button(role: .destructive, action: {
                            authManager.logout()
                        }) {
                            Label("Sign Out", systemImage: "arrow.backward.circle")
                        }
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }
}

#Preview {
    MainTabView()
        .environmentObject(AuthManager())
}
